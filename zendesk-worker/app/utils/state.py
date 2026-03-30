import json
import os
import time
from app.config import STATE_FILE


def load_state():
    if not os.path.exists(STATE_FILE):
        return {}
    with open(STATE_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, sort_keys=True)


def get_resume_state(mode: str):
    state = load_state()
    if state.get("status") == "running" and state.get("mode") == mode:
        return state
    return None


def start_run(mode: str, start_time: str):
    state = load_state()
    now = int(time.time())
    state.update(
        {
            "mode": mode,
            "status": "running",
            "started_at_epoch": state.get("started_at_epoch", now) if state.get("status") == "running" and state.get("mode") == mode else now,
            "resume_start_time": str(start_time),
            "last_run_at_epoch": now,
        }
    )
    save_state(state)
    return state


def checkpoint_run(
    mode: str,
    generated_timestamp,
    ticket_id,
    rows_written: int,
    start_time: str,
):
    state = load_state()
    state.update(
        {
            "mode": mode,
            "status": "running",
            "resume_start_time": str(start_time),
            "last_ticket_generated_timestamp": str(generated_timestamp),
            "last_ticket_id": str(ticket_id),
            "rows_written": int(rows_written),
            "last_successful_sheet_write_at_epoch": int(time.time()),
            "last_run_at_epoch": int(time.time()),
        }
    )
    save_state(state)


def complete_run(
    mode: str,
    generated_timestamp=None,
    ticket_id=None,
    rows_written: int = 0,
    start_time: str | None = None,
):
    state = load_state()
    now = int(time.time())
    state.update(
        {
            "mode": mode,
            "status": "complete",
            "completed_at_epoch": now,
            "last_run_at_epoch": now,
            "rows_written": int(rows_written),
        }
    )
    if start_time is not None:
        state["resume_start_time"] = str(start_time)
    if generated_timestamp is not None:
        state["last_ticket_generated_timestamp"] = str(generated_timestamp)
    if ticket_id is not None:
        state["last_ticket_id"] = str(ticket_id)
    save_state(state)
