//! Windows power observations do not infer agent completion. They invalidate timing.
//! https://learn.microsoft.com/windows/win32/api/powerbase/nf-powerbase-powerregistersuspendresumenotification
use clawdle_local_runtime::Repository;
use std::{ffi::c_void, sync::Arc};
use windows_sys::Win32::{
    System::Power::{
        PowerRegisterSuspendResumeNotification, PowerUnregisterSuspendResumeNotification,
        DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS,
    },
    UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND,
    },
};
struct Context {
    repo: Arc<Repository>,
    notify: Arc<dyn Fn(i64) + Send + Sync>,
}
unsafe extern "system" fn callback(
    context: *const c_void,
    kind: u32,
    _setting: *const c_void,
) -> u32 {
    if context.is_null()
        || ![PBT_APMSUSPEND, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND].contains(&kind)
    {
        return 0;
    }
    // Context stays allocated until successful unregister; no renderer is involved.
    let context = unsafe { &*(context.cast::<Context>()) };
    if let Ok(entry) = context.repo.append(
        &uuid::Uuid::new_v4().to_string(),
        "runtime",
        serde_json::json!({"type":"runtime.interrupted"}),
    ) {
        (context.notify)(entry.seq);
    }
    0
}
pub struct PowerMonitor {
    handle: usize,
    context: Option<Box<Context>>,
}
impl PowerMonitor {
    pub fn register(
        repo: Arc<Repository>,
        notify: Arc<dyn Fn(i64) + Send + Sync>,
    ) -> std::io::Result<Self> {
        let mut context = Box::new(Context { repo, notify });
        let params = DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(callback),
            Context: (&mut *context as *mut Context).cast(),
        };
        let mut handle = std::ptr::null_mut();
        let status = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                (&params as *const DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS)
                    .cast_mut()
                    .cast(),
                &mut handle,
            )
        };
        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status as i32));
        }
        Ok(Self {
            handle: handle as usize,
            context: Some(context),
        })
    }
}
impl Drop for PowerMonitor {
    fn drop(&mut self) {
        let status = unsafe { PowerUnregisterSuspendResumeNotification(self.handle as _) };
        if status != 0 {
            if let Some(context) = self.context.take() {
                let _ = Box::leak(context);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_registration_and_callback_preserve_puzzle_and_interrupt_every_power_boundary() {
        let repo = Arc::new(Repository::open(std::path::Path::new(":memory:")).unwrap());
        repo.commit(0, 1, serde_json::json!({"puzzle":"saved"}), vec![])
            .unwrap();
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = count.clone();
        let monitor = PowerMonitor::register(
            repo.clone(),
            Arc::new(move |_| {
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }),
        )
        .unwrap();
        let context = (&**monitor.context.as_ref().unwrap() as *const Context).cast();
        for kind in [PBT_APMSUSPEND, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND] {
            unsafe {
                callback(context, kind, std::ptr::null());
            }
        }
        unsafe {
            callback(context, 0, std::ptr::null());
        }
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(repo.read(1, 10).unwrap().len(), 3);
        assert_eq!(
            repo.snapshot().unwrap().checkpoint.unwrap().state["puzzle"],
            "saved"
        );
        drop(monitor);
    }
}
