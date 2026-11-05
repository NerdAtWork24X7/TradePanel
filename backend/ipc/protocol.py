"""JSON-RPC 2.0 wire protocol constants and validation helpers.

One UTF-8 JSON message per line over the sidecar's stdin/stdout. stdout is
reserved exclusively for protocol frames; every diagnostic goes to stderr.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 8 * 1024 * 1024
MAX_INFLIGHT = 64
MAX_TRACKED_IDS = 512

# JSON-RPC 2.0 reserved codes plus application-specific codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

APP_ERROR = -32000
UNAVAILABLE = -32001          # credentials missing / service not ready
TIMEOUT = -32002
EXECUTION_UNKNOWN = -32004
SERVER_BUSY = -32005
PROTOCOL_MISMATCH = -32010
SHUTTING_DOWN = -32011
DUPLICATE_REQUEST = -32012
PAYLOAD_TOO_LARGE = -32013


class RpcError(Exception):
    """An error that maps directly onto a JSON-RPC error object."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def to_dict(self) -> dict:
        out = {"code": self.code, "message": self.message}
        if self.data is not None:
            out["data"] = self.data
        return out


def dumps(payload: dict) -> bytes:
    """Serialise one frame (compact, no ASCII escaping, NaN rejected)."""
    return json.dumps(
        payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


@dataclass(frozen=True)
class Request:
    id: str
    method: str
    params: dict


@dataclass(frozen=True)
class Notification:
    method: str
    params: dict


class MessageError(Exception):
    """Malformed frame; carries the id when one could be recovered."""

    def __init__(
        self,
        code: int,
        message: str,
        request_id: str | None = None,
        data: Any = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.request_id = request_id
        self.data = data

    def to_dict(self) -> dict:
        out = {"code": self.code, "message": self.message}
        if self.data is not None:
            out["data"] = self.data
        return out


def _normalise_id(value: Any) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (str, int)):
        text = str(value)
        return text if 0 < len(text) <= 128 else None
    return None


def parse_frame(raw: bytes) -> Request | Notification | MessageError:
    """Parse one newline-stripped frame.

    Returns a Request, a Notification or a MessageError carrying the JSON-RPC
    error to send back (and the recovered id, if any).
    """
    if len(raw) > MAX_MESSAGE_BYTES:
        return MessageError(PAYLOAD_TOO_LARGE, "Message exceeds the size limit")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return MessageError(PARSE_ERROR, "Message is not valid UTF-8")
    if not text.strip():
        return MessageError(PARSE_ERROR, "Empty message")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return MessageError(PARSE_ERROR, "Malformed JSON")
    if not isinstance(payload, dict):
        return MessageError(INVALID_REQUEST, "Message must be a JSON object")
    if payload.get("jsonrpc") != "2.0":
        return MessageError(
            INVALID_REQUEST,
            "jsonrpc must be '2.0'",
            _normalise_id(payload.get("id")),
        )

    raw_id = payload.get("id")
    has_id = "id" in payload and raw_id is not None
    request_id = _normalise_id(raw_id) if has_id else None
    if has_id and request_id is None:
        return MessageError(INVALID_REQUEST, "Invalid request id")

    method = payload.get("method")
    if not isinstance(method, str) or not method or len(method) > 120:
        return MessageError(
            INVALID_REQUEST, "method must be a non-empty string", request_id
        )
    params = payload.get("params", {})
    if params is None:
        params = {}
    if not isinstance(params, dict):
        return MessageError(INVALID_REQUEST, "params must be an object", request_id)

    if not has_id:
        return Notification(method=method, params=params)
    return Request(id=request_id, method=method, params=params)


def response_ok(request_id: str, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def response_error(request_id: str | None, error: RpcError | MessageError) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": error.to_dict()}


def notification(method: str, params: dict) -> dict:
    return {"jsonrpc": "2.0", "method": method, "params": params}
