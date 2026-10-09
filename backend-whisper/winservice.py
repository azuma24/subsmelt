"""Windows Service entry for run_server.exe (``run_server.exe --service``).

sc.exe used to register plain ``run_server.exe`` as the service binary. That
process never talked to the Service Control Manager, so the SCM waited 30 s
for a status report, failed the start with error 1053 and killed it. This
module is the missing conversation: a ``ServiceFramework`` whose ``SvcDoRun``
loads config the way the console launcher does and runs uvicorn in-process
(pywin32 reports RUNNING just before calling it and STOPPED when it returns),
and whose ``SvcStop`` reports STOP_PENDING and asks that server to exit.

pywin32 exists only on Windows, so its imports stay inside the functions that
need them; ``ServiceSession`` holds the part that runs anywhere and is what
the tests exercise.
"""

from __future__ import annotations

import logging

import run_server

SERVICE_NAME = "SubSmeltWhisper"
DISPLAY_NAME = "SubSmelt Whisper Backend"


class ServiceSession:
    """One service lifetime: ``run`` serves until ``stop`` is called.

    ``stop`` may arrive before ``run`` has built the server (config loading
    and the CUDA probe take a moment), so the request is remembered and
    applied the instant a server is attached.
    """

    def __init__(self) -> None:
        self.server = None
        self.stop_requested = False

    def attach(self, server) -> None:
        self.server = server
        if self.stop_requested:
            server.should_exit = True

    def stop(self) -> None:
        self.stop_requested = True
        if self.server is not None:
            self.server.should_exit = True

    def run(self) -> None:
        config = run_server.load_config()
        file_logging, _gpu_ok, _message = run_server.prepare_runtime(config)
        # A service has no console; the file handler prepare_runtime installed
        # on the root logger is where these can be read.
        for line in run_server.exposure_warnings(config):
            logging.getLogger("run_server").warning(line)

        import uvicorn  # type: ignore

        server = uvicorn.Server(uvicorn.Config("app.main:app", **run_server.uvicorn_kwargs(config, file_logging)))
        self.attach(server)
        # uvicorn skips its signal handlers off the main thread, which is where
        # the SCM runs SvcDoRun; should_exit is the only stop path here.
        server.run()


def service_class():
    """The ``ServiceFramework`` subclass, built where pywin32 is importable."""
    import win32service  # type: ignore
    import win32serviceutil  # type: ignore

    class WhisperService(win32serviceutil.ServiceFramework):
        _svc_name_ = SERVICE_NAME
        _svc_display_name_ = DISPLAY_NAME
        _svc_description_ = "SubSmelt remote Whisper transcription backend (CUDA)."

        def __init__(self, args) -> None:
            super().__init__(args)
            self.session = ServiceSession()

        def SvcStop(self) -> None:
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
            self.session.stop()

        def SvcDoRun(self) -> None:
            # pywin32 has already reported RUNNING, before the model stack
            # loads: the SCM allows 30 s for that, and /health is the real
            # readiness signal. An exception here is written to the Event Log
            # by the pywin32 host and ends the service with an error status.
            self.session.run()

    return WhisperService


def run_as_service() -> int:
    """Hand this process to the Service Control Manager.

    The frozen exe hosts exactly one service, so the pywin32 "single service"
    dispatcher is used rather than the module-name based HandleCommandLine.
    Blocks until the service stops.
    """
    import servicemanager  # type: ignore

    servicemanager.Initialize()
    servicemanager.PrepareToHostSingle(service_class())
    servicemanager.StartServiceCtrlDispatcher()
    return 0
