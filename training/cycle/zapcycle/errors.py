"""Errors with the exit codes of the cycle commands: 1 error, 2 refused by a guard, 3 lock busy."""


class CycleError(Exception):
    exit_code = 1


class GuardError(CycleError):
    """A guard refused the call (wrong mode, bucket, endpoint, role or an open A/B window)."""

    exit_code = 2


class LockBusy(CycleError):
    exit_code = 3


class FormatError(CycleError):
    """A JSON object does not follow its format (contract section 1)."""

    def __init__(self, schema: str, errors: list[str]):
        self.schema = schema
        self.errors = errors
        super().__init__(f"{schema}: " + "; ".join(errors[:5]))
