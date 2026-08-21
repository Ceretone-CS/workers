from app.config import validate_config, WORKER_MODE
from app.sync_tickets import run_ticket_sync
from app.survey_suppression import refresh_survey_cutoff_conditions


def main():
    validate_config()
    print(f"Starting zendesk_worker with mode='{WORKER_MODE}'...")

    if WORKER_MODE in {"backfill", "incremental", "tickets"}:
        run_ticket_sync(mode="backfill" if WORKER_MODE == "backfill" else "incremental")
        refresh_survey_cutoff_conditions()
    elif WORKER_MODE == "tags":
        print("Tag sync via worker is disabled. Use the Google Sheets Apps Script instead.")

    print("zendesk_worker run complete.")


if __name__ == "__main__":
    main()
