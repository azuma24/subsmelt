"""Thread-to-Tk message hand-off in the Whisper control window.

Tkinter's ``after()`` silently does nothing when it is called from a thread
other than the one that created the interpreter — no exception, no callback, on
a threaded Tcl build. The readiness poller runs on a worker thread, so it cannot
touch Tk at all: it leaves text here and the Tk thread collects it on its own
timer.
"""
import importlib.util
import threading
import unittest
from pathlib import Path

_MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "packaging" / "windows" / "tray" / "whisper_gui.py"
)
_spec = importlib.util.spec_from_file_location("whisper_gui", _MODULE_PATH)
whisper_gui = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(whisper_gui)


class ThreadMessagesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.messages = whisper_gui.ThreadMessages()

    def test_nothing_pending_yields_none(self):
        self.assertIsNone(self.messages.latest())

    def test_a_posted_message_comes_back(self):
        self.messages.post("Ready")
        self.assertEqual(self.messages.latest(), "Ready")

    def test_collecting_drains_the_queue(self):
        self.messages.post("Ready")
        self.messages.latest()
        self.assertIsNone(self.messages.latest())

    def test_only_the_newest_message_survives(self):
        # Each message is a full replacement for the info panel, so showing an
        # older one after a newer one would rewind what the operator is told.
        for text in ("starting", "still starting", "Ready"):
            self.messages.post(text)
        self.assertEqual(self.messages.latest(), "Ready")
        self.assertIsNone(self.messages.latest())

    def test_a_worker_thread_can_post(self):
        # The whole point: this is the call the readiness poller makes, and it
        # must not touch Tk.
        worker = threading.Thread(target=self.messages.post, args=("from a thread",))
        worker.start()
        worker.join()
        self.assertEqual(self.messages.latest(), "from a thread")

    def test_a_message_from_a_superseded_launch_is_discarded(self):
        # Stop/Restart while a readiness poll is in flight: the old worker is
        # still alive and will report on a launch that no longer exists. Its
        # "Start failed" would land on top of the explicit "Stop: stopped".
        self.messages.post("Start failed", generation=1)
        self.assertIsNone(self.messages.latest(generation=2))

    def test_a_message_from_the_current_launch_survives(self):
        self.messages.post("Ready", generation=2)
        self.assertEqual(self.messages.latest(generation=2), "Ready")

    def test_a_stale_message_does_not_mask_a_current_one(self):
        # Both queued before the Tk thread drains: the stale one must be
        # dropped without consuming the live one behind it.
        self.messages.post("stale", generation=1)
        self.messages.post("live", generation=2)
        self.assertEqual(self.messages.latest(generation=2), "live")

    def test_generation_defaults_keep_simple_callers_working(self):
        self.messages.post("plain")
        self.assertEqual(self.messages.latest(), "plain")

    def test_concurrent_posts_are_not_lost_or_duplicated(self):
        threads = [
            threading.Thread(target=self.messages.post, args=(f"msg-{i}",))
            for i in range(20)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        # One survivor, and it is one of the messages actually sent.
        survivor = self.messages.latest()
        self.assertIn(survivor, {f"msg-{i}" for i in range(20)})
        self.assertIsNone(self.messages.latest())


if __name__ == "__main__":
    unittest.main()
