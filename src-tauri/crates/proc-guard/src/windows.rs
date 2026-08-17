//! Windows backend: a Job Object reclaims the process tree.

use std::io;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenThread, ResumeThread, TerminateProcess, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    PROCESS_SET_QUOTA, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
};

/// A kernel handle that closes itself.
///
/// The `HANDLE` pointer is a process-wide table index with no thread affinity,
/// so moving one across threads is sound.
struct OwnedHandle(HANDLE);

unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

pub(crate) struct Inner {
    job: OwnedHandle,
}

impl Inner {
    pub(crate) fn new() -> io::Result<Self> {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = OwnedHandle(job);

        // KILL_ON_JOB_CLOSE is the whole point: when this process dies the handle
        // closes, and the kernel — not our cleanup code — terminates the tree.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let configured = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }

        Ok(Self { job })
    }

    pub(crate) fn spawn(
        &self,
        command: &mut tokio::process::Command,
    ) -> io::Result<tokio::process::Child> {
        // CREATE_SUSPENDED closes the window between spawn and assignment: an
        // already-running child could fork a descendant that escapes the job.
        // CREATE_NO_WINDOW gives the child an invisible console, which its own
        // children inherit — that is what keeps tool subprocesses from flashing
        // a black window on screen.
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);

        let child = command.spawn()?;
        let handle = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("guarded child exited before it could be adopted"))?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("guarded child exited before it could be adopted"))?;

        if unsafe { AssignProcessToJobObject(self.job.0, handle) } == 0 {
            let failure = io::Error::last_os_error();
            // The child is frozen; without this it would linger forever.
            unsafe { TerminateProcess(handle, 1) };
            return Err(failure);
        }

        resume_process(pid)?;
        Ok(child)
    }

    pub(crate) fn adopt(&self, pid: u32) -> io::Result<()> {
        // The two rights `AssignProcessToJobObject` insists on, and nothing more:
        // a handle able to read the process's memory would be a bigger capability
        // than this needs to hold.
        let handle = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let handle = OwnedHandle(handle);

        if unsafe { AssignProcessToJobObject(self.job.0, handle.0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn terminate_all(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.job.0, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// Resume the threads of a process created with `CREATE_SUSPENDED`.
///
/// `std` hands back a process handle but never a thread handle, so the initial
/// thread has to be recovered by walking the system-wide thread list.
fn resume_process(pid: u32) -> io::Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snapshot = OwnedHandle(snapshot);

    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;

    let mut resumed = false;
    let mut walking = unsafe { Thread32First(snapshot.0, &mut entry) };
    while walking != 0 {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                unsafe { ResumeThread(thread) };
                unsafe { CloseHandle(thread) };
                resumed = true;
            }
        }
        // Thread32Next overwrites the entry, dwSize included.
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        walking = unsafe { Thread32Next(snapshot.0, &mut entry) };
    }

    if !resumed {
        return Err(io::Error::other(format!(
            "no thread of guarded child {pid} could be resumed"
        )));
    }
    Ok(())
}
