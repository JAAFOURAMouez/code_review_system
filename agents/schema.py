"""
Small JSON helpers for the LLM agents: pull a JSON object out of a model reply and check it
against a JSON Schema.

The validator covers the subset of JSON Schema the agents use (type, properties, required,
additionalProperties, items, enum, minimum/maximum, minLength), so no extra dependency is needed.
"""

import json
import re
from typing import Any, Dict, List, Optional

_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "null": type(None),
}


def _is_type(value: Any, name: str) -> bool:
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return isinstance(value, _TYPES[name])


def validate(value: Any, schema: Dict[str, Any], path: str = "$") -> List[str]:
    """Return a list of problems (empty when ``value`` matches ``schema``)."""
    errors: List[str] = []
    types = schema.get("type")
    if types is not None:
        names = types if isinstance(types, list) else [types]
        if not any(_is_type(value, n) for n in names):
            return [f"{path}: expected {' or '.join(names)}, got {type(value).__name__}"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: must be one of {schema['enum']}")
    if isinstance(value, str) and len(value) < schema.get("minLength", 0):
        errors.append(f"{path}: must not be empty")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: must be >= {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: must be <= {schema['maximum']}")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required key '{key}'")
        for key, sub in value.items():
            if key in props:
                errors.extend(validate(sub, props[key], f"{path}.{key}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: unexpected key '{key}'")
    if isinstance(value, list) and "items" in schema:
        for i, item in enumerate(value):
            errors.extend(validate(item, schema["items"], f"{path}[{i}]"))
    return errors


_FENCE = re.compile(r"```(?:json)?\s*\n(.*?)\n?```", re.S)


def extract_json(text: Optional[str]) -> Any:
    """Parse the JSON object in a model reply: plain JSON, a ```json fence, or the outermost
    ``{...}``. Raises ValueError when there is none."""
    if not text or not text.strip():
        raise ValueError("the reply is empty")
    candidates = [text.strip()]
    candidates += [m.group(1) for m in _FENCE.finditer(text)]
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end:
        candidates.append(text[start:end + 1])
    for cand in candidates:
        try:
            return json.loads(cand)
        except json.JSONDecodeError:
            continue
    raise ValueError("the reply does not contain a JSON object")


def normalize_code(text: str) -> str:
    """Code from a model: without a surrounding ```python fence, ending with one newline."""
    code = strip_code_fences(text).rstrip()
    return code + "\n" if code else ""


def strip_code_fences(text: str) -> str:
    """Return the code inside a single ```python fence, or the text unchanged."""
    t = (text or "").strip()
    m = re.fullmatch(r"```[a-zA-Z0-9_+-]*\n(.*?)\n?```", t, re.S)
    return m.group(1) if m else t
