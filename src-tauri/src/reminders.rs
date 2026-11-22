//! Local reminders via UNUserNotificationCenter (only when running from a bundled .app).

use serde::Deserialize;

#[derive(Deserialize)]
pub struct ReminderItem {
    id: String,
    title: String,
    body: String,
    /// Local time, `YYYY-MM-DD HH:mm`.
    at: String,
}

/// Parses `YYYY-MM-DD HH:mm` into (year, month, day, hour, minute).
fn parse_at(at: &str) -> Option<(i64, i64, i64, i64, i64)> {
    let (date, time) = at.trim().split_once(' ')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let mut t = time.trim().split(':').map(|p| p.parse::<i64>().ok());
    let parsed = (d.next()??, d.next()??, d.next()??, t.next()??, t.next()??);
    let (year, month, day, hour, minute) = parsed;
    let valid = d.next().is_none()
        && t.next().is_none()
        && chrono::NaiveDate::from_ymd_opt(
            year.try_into().ok()?,
            month.try_into().ok()?,
            day.try_into().ok()?,
        ).is_some()
        && (0..=23).contains(&hour)
        && (0..=59).contains(&minute);
    valid.then_some(parsed)
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{parse_at, ReminderItem};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{NSBundle, NSDateComponents, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNCalendarNotificationTrigger, UNMutableNotificationContent,
        UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
        UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use parking_lot::Mutex;
    use tokio::sync::oneshot;

    // A replacement must finish before a newer set can remove its requests.
    static SCHEDULING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Calling UNUserNotificationCenter outside an app bundle aborts the process.
    pub fn in_app_bundle() -> bool {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "TasksNotificationDelegate"]
        struct NotificationDelegate;

        unsafe impl NSObjectProtocol for NotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
            /// Show reminders as banners even while the app is frontmost.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion_handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }
        }
    );

    impl NotificationDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    pub fn init() {
        if !in_app_bundle() {
            eprintln!("tasks: not running from an app bundle; notifications disabled");
            return;
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate = NotificationDelegate::new();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly; keep it alive for the app's lifetime.
        std::mem::forget(delegate);
        let handler = RcBlock::new(|granted: Bool, error: *mut NSError| {
            if let Some(error) = unsafe { error.as_ref() } {
                eprintln!("tasks: notification authorization failed: {error}");
            } else if !granted.as_bool() {
                eprintln!("tasks: notification authorization denied");
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &handler,
        );
    }

    pub async fn schedule(items: &[ReminderItem]) -> Result<(), String> {
        if !in_app_bundle() {
            eprintln!(
                "tasks: not running from an app bundle; skipping {} reminder(s)",
                items.len()
            );
            return Ok(());
        }
        let parsed = items
            .iter()
            .map(|item| {
                parse_at(&item.at)
                    .map(|at| (item, at))
                    .ok_or_else(|| format!("invalid reminder time {:?} for {}", item.at, item.id))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let _scheduling = SCHEDULING.lock().await;

        // Clearing reminders does not need permission. Nonempty replacements must
        // surface both denial and system errors before claiming success.
        if !parsed.is_empty() {
            let authorization = objc2::rc::autoreleasepool(|_| {
                let (send, receive) = oneshot::channel();
                let reply = Mutex::new(Some(send));
                let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
                    let result = if let Some(error) = unsafe { error.as_ref() } {
                        Err(format!("notification authorization failed: {error}"))
                    } else if !granted.as_bool() {
                        Err("Notifications are denied. Enable Tasks in System Settings → Notifications.".to_owned())
                    } else {
                        Ok(())
                    };
                    if let Some(reply) = reply.lock().take() {
                        let _ = reply.send(result);
                    }
                });
                UNUserNotificationCenter::currentNotificationCenter()
                    .requestAuthorizationWithOptions_completionHandler(
                        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                        &handler,
                    );
                receive
            });
            authorization.await.map_err(|_| "notification authorization callback was lost".to_owned())??;
        }

        objc2::rc::autoreleasepool(|_| {
            UNUserNotificationCenter::currentNotificationCenter().removeAllPendingNotificationRequests();
        });
        for (item, (year, month, day, hour, minute)) in parsed {
            let scheduled = objc2::rc::autoreleasepool(|_| {
                let content = UNMutableNotificationContent::new();
                content.setTitle(&NSString::from_str(&item.title));
                content.setBody(&NSString::from_str(&item.body));
                content.setSound(Some(&UNNotificationSound::defaultSound()));

                let components = NSDateComponents::new();
                components.setYear(year as isize);
                components.setMonth(month as isize);
                components.setDay(day as isize);
                components.setHour(hour as isize);
                components.setMinute(minute as isize);
                let trigger =
                    UNCalendarNotificationTrigger::triggerWithDateMatchingComponents_repeats(
                        &components,
                        false,
                    );
                let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                    &NSString::from_str(&item.id),
                    &content,
                    Some(&trigger),
                );
                let (send, receive) = oneshot::channel();
                let reply = Mutex::new(Some(send));
                let id = item.id.clone();
                let done = RcBlock::new(move |error: *mut NSError| {
                    let result = if let Some(error) = unsafe { error.as_ref() } {
                        Err(format!("cannot schedule reminder {id}: {error}"))
                    } else {
                        Ok(())
                    };
                    if let Some(reply) = reply.lock().take() {
                        let _ = reply.send(result);
                    }
                });
                UNUserNotificationCenter::currentNotificationCenter()
                    .addNotificationRequest_withCompletionHandler(&request, Some(&done));
                receive
            });
            scheduled.await.map_err(|_| "notification scheduling callback was lost".to_owned())??;
        }
        Ok(())
    }
}

/// Requests notification authorization (alert + sound) once at startup.
pub fn init() {
    #[cfg(target_os = "macos")]
    imp::init();
}

#[tauri::command]
pub async fn schedule_reminders(items: Vec<ReminderItem>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return imp::schedule(&items).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = items;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::parse_at;

    #[test]
    fn parses_reminder_time() {
        assert_eq!(parse_at("2026-10-04 09:05"), Some((2026, 10, 4, 9, 5)));
        assert_eq!(parse_at("2026-13-04 09:05"), None);
        assert_eq!(parse_at("2026-10-04"), None);
        assert_eq!(parse_at("2026-10-04 9:5:1"), None);
    }
}
