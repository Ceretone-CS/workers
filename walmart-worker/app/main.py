from app.config import validate_config
from app.sync import run_loop


def main():
    validate_config()
    run_loop()


if __name__ == "__main__":
    main()
