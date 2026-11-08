"""
Shared LLM client for the agents: Hugging Face Inference Providers through the OpenAI-compatible
router (``https://router.huggingface.co/v1``).

Three entry points:

* ``generate_text(prompt)``: plain text (kept for compatibility).
* ``generate_json(prompt, schema)``: structured output. Asks the provider for JSON that follows
  ``schema`` (``response_format=json_schema``), falls back to ``json_object`` and then to plain
  text when the provider does not support it, and always validates the reply against the schema
  (one repair round trip when it does not match).
* ``run_tool_loop(...)``: function calling. The model calls tools (linters, tests), sees their
  results and finishes by calling a ``submit`` function whose parameters are the final JSON.

Configuration (environment or ``.env``): ``HF_API_TOKEN``, ``HF_MODEL``, ``HF_MIN_TOKENS``,
``HF_REASONING_EFFORT``, ``HF_REQUEST_TIMEOUT``, ``HF_STRUCTURED_MODE``
(``json_schema`` | ``json_object`` | ``none``).
"""

import json
import os
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from dotenv import load_dotenv

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from agents.schema import extract_json, validate  # noqa: E402  pylint: disable=wrong-import-position

load_dotenv()

HF_BASE_URL = os.getenv("HF_BASE_URL", "https://router.huggingface.co/v1")
HF_MODEL = os.getenv("HF_MODEL", "openai/gpt-oss-20b:groq")
STRUCTURED_MODES = ("json_schema", "json_object", "none")

_client = None  # pylint: disable=invalid-name
_effort_supported = True  # pylint: disable=invalid-name
# Remembered per process: once a provider refuses a response_format we stop sending it.
_structured_mode = os.getenv("HF_STRUCTURED_MODE", "json_schema").strip() or "json_schema"
USAGE = {"prompt_tokens": 0, "completion_tokens": 0, "requests": 0}


class LLMError(Exception):
    """The model could not produce a usable answer. ``trace`` lists the tool calls made before
    the failure (function-calling loop only)."""

    def __init__(self, message: str, trace: Optional[List[Dict[str, Any]]] = None):
        super().__init__(message)
        self.trace = trace or []


class ToolsUnsupported(LLMError):
    """The model or provider refused the ``tools`` parameter."""


def get_client():
    """The OpenAI-compatible client, created on first use (so importing never fails)."""
    global _client  # pylint: disable=global-statement
    if _client is None:
        token = os.getenv("HF_API_TOKEN")
        if not token:
            raise LLMError("HF_API_TOKEN environment variable not set")
        from openai import OpenAI  # pylint: disable=import-outside-toplevel
        _client = OpenAI(base_url=HF_BASE_URL, api_key=token,
                         timeout=float(os.getenv("HF_REQUEST_TIMEOUT", "120")), max_retries=2)
    return _client


def set_client(client) -> None:
    """Use another client (tests use a fake one)."""
    global _client  # pylint: disable=global-statement
    _client = client


def _is_bad_request(exc: Exception) -> bool:
    """A 400/422 from the provider: the request shape (not the network or the key) was refused."""
    status = getattr(exc, "status_code", None)
    return status in (400, 422) or type(exc).__name__ in ("BadRequestError", "UnprocessableEntityError")


def _record_usage(resp) -> None:
    usage = getattr(resp, "usage", None)
    USAGE["requests"] += 1
    if usage is not None:
        USAGE["prompt_tokens"] += getattr(usage, "prompt_tokens", 0) or 0
        USAGE["completion_tokens"] += getattr(usage, "completion_tokens", 0) or 0


def _create(**kwargs):
    """One chat completion, sending ``reasoning_effort`` when the provider accepts it."""
    global _effort_supported  # pylint: disable=global-statement
    effort = os.getenv("HF_REASONING_EFFORT", "low").strip()
    client = get_client()
    if effort and _effort_supported:
        try:
            resp = client.chat.completions.create(**kwargs, extra_body={"reasoning_effort": effort})
            _record_usage(resp)
            return resp
        except Exception as e:  # pylint: disable=broad-except
            if not _is_bad_request(e):
                raise
            # Maybe the provider does not accept reasoning_effort: retry without it, and only
            # stop sending it if that retry works (the 400 may be about something else).
            resp = client.chat.completions.create(**kwargs)
            _effort_supported = False
            _record_usage(resp)
            return resp
    resp = client.chat.completions.create(**kwargs)
    _record_usage(resp)
    return resp


def complete(messages: List[Dict[str, Any]], max_tokens: int = 1500, **kwargs):
    """A chat completion that is not cut off. Reasoning models spend part of ``max_tokens`` on
    hidden reasoning, so the budget is at least ``HF_MIN_TOKENS`` and is doubled (twice) when the
    reply stops at the limit. Returns the first choice."""
    budget = max(max_tokens, int(os.getenv("HF_MIN_TOKENS", "2000")))
    choice = None
    for attempt in range(3):
        resp = _create(model=os.getenv("HF_MODEL", HF_MODEL), messages=messages,
                       max_tokens=budget, **kwargs)
        choice = resp.choices[0]
        msg = choice.message
        has_output = bool((msg.content or "").strip()) or bool(getattr(msg, "tool_calls", None))
        if choice.finish_reason != "length" and has_output:
            return choice
        if attempt < 2:
            budget *= 2
    raise LLMError(
        f"the model reply was {'cut off' if choice and choice.finish_reason == 'length' else 'empty'} "
        f"(max_tokens={budget}); raise HF_MIN_TOKENS or use a non-reasoning HF_MODEL"
    )


def generate_text(prompt: str, max_tokens: int = 500, temperature: float = 0.2,
                  top_p: float = 0.95) -> str:
    """Plain-text generation (kept for scripts that still use it)."""
    try:
        choice = complete([{"role": "user", "content": prompt}], max_tokens,
                          temperature=temperature, top_p=top_p)
        return choice.message.content
    except Exception as e:
        raise LLMError(f"API call failed: {e}") from e


# ------------------------------------------------------------------ structured output

_STRICT_UNSUPPORTED = ("minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems")


def provider_schema(schema: Any) -> Any:
    """The schema sent as ``response_format``: without the keywords strict mode often rejects.
    Replies are still validated locally against the full schema."""
    if isinstance(schema, dict):
        return {k: provider_schema(v) for k, v in schema.items() if k not in _STRICT_UNSUPPORTED}
    if isinstance(schema, list):
        return [provider_schema(v) for v in schema]
    return schema


def _response_format(mode: str, name: str, schema: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if mode == "json_schema":
        return {"type": "json_schema",
                "json_schema": {"name": name, "schema": provider_schema(schema), "strict": True}}
    if mode == "json_object":
        return {"type": "json_object"}
    return None


def generate_json(prompt: str, schema: Dict[str, Any], name: str = "result",
                  system: Optional[str] = None, max_tokens: int = 1500,
                  temperature: float = 0.2) -> Dict[str, Any]:
    """Return a dict that matches ``schema``. Raises LLMError when the model cannot produce one."""
    global _structured_mode  # pylint: disable=global-statement
    instructions = ("Reply with a single JSON object that follows this JSON Schema, and nothing "
                    "else (no markdown, no prose):\n" + json.dumps(schema))
    messages: List[Dict[str, Any]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": f"{prompt}\n\n{instructions}"})

    last_problem = ""
    for _ in range(2):  # first answer + one repair round trip
        mode_index = STRUCTURED_MODES.index(_structured_mode) if _structured_mode in STRUCTURED_MODES else 0
        choice = None
        for mode in STRUCTURED_MODES[mode_index:]:
            fmt = _response_format(mode, name, schema)
            try:
                kwargs = {"temperature": temperature}
                if fmt:
                    kwargs["response_format"] = fmt
                choice = complete(messages, max_tokens, **kwargs)
                _structured_mode = mode
                break
            except LLMError:
                raise
            except Exception as e:  # pylint: disable=broad-except
                if fmt is None or not _is_bad_request(e):
                    raise LLMError(f"API call failed: {e}") from e
                # this provider/model does not support this response_format: try the next one
        if choice is None:
            raise LLMError("no structured output mode is supported by this provider")
        content = choice.message.content or ""
        try:
            data = extract_json(content)
            problems = validate(data, schema)
        except ValueError as e:
            data, problems = None, [str(e)]
        if not problems:
            return data
        last_problem = "; ".join(problems[:8])
        messages.append({"role": "assistant", "content": content})
        messages.append({"role": "user", "content": (
            f"That reply does not match the schema: {last_problem}. "
            "Send the corrected JSON object only.")})
    raise LLMError(f"the model did not return valid JSON: {last_problem}")


# ------------------------------------------------------------------ function calling

def _tool_call_dict(call) -> Dict[str, Any]:
    return {"id": call.id, "type": "function",
            "function": {"name": call.function.name, "arguments": call.function.arguments or "{}"}}


def _summary(result: Any) -> str:
    """One line describing a tool result, for the trace shown to people."""
    if not isinstance(result, dict):
        return str(result)[:120]
    if result.get("tool") == "run_tests" and result.get("status") == "ok":
        return (f"{result.get('tests', 0)} tests, {result.get('failures', 0)} failures, "
                f"{result.get('errors', 0)} errors")
    if "accepted" in result:
        return "accepted" if result["accepted"] else "refused: " + "; ".join(result.get("problems", []))[:150]
    if "count" in result:
        return f"{result.get('status')}: {result['count']} findings"
    if "valid" in result:
        return "valid" if result["valid"] else f"syntax error line {result.get('line')}"
    return str(result.get("status") or result.get("error") or "done")


def _execute_call(call, by_name: Dict[str, Any], submit_name: str, submit_schema: Dict[str, Any],
                  on_submit: Optional[Callable[[Dict[str, Any]], List[str]]]
                  ) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    """Run one tool call from the model. Returns (result sent back, accepted submission or None)."""
    name = call.function.name
    try:
        args = json.loads(call.function.arguments or "{}")
        if not isinstance(args, dict):
            raise ValueError("arguments must be a JSON object")
    except ValueError as e:
        return {"error": f"invalid JSON arguments: {e}"}, None
    if name == submit_name:
        problems = validate(args, submit_schema)
        if not problems and on_submit:
            try:
                problems = on_submit(args)
            except Exception as e:  # pylint: disable=broad-except
                problems = [f"the submission could not be checked: {e}"]
        if problems:
            return {"accepted": False, "problems": problems[:10]}, None
        return {"accepted": True}, args
    if name not in by_name:
        return {"error": f"unknown tool '{name}'. Available: "
                f"{', '.join(list(by_name) + [submit_name])}"}, None
    problems = validate(args, by_name[name].parameters)
    if problems:
        return {"error": "; ".join(problems)}, None
    try:
        return by_name[name].call(args), None
    except Exception as e:  # pylint: disable=broad-except
        return {"error": f"the tool failed: {e}"}, None


def run_tool_loop(system: str, user: str, tools: List[Any], submit_name: str,
                  submit_description: str, submit_schema: Dict[str, Any],
                  max_steps: int = 8, deadline: Optional[float] = None,
                  max_tokens: int = 3000, temperature: float = 0.1,
                  on_submit: Optional[Callable[[Dict[str, Any]], List[str]]] = None,
                  ) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Let the model call ``tools`` until it calls ``submit_name`` with arguments matching
    ``submit_schema``. ``on_submit`` may return extra problems (e.g. "the code does not compile"),
    which are sent back so the model can fix them. Returns (submitted arguments, trace).

    Near ``deadline`` (a ``time.monotonic()`` value) or at the last step, the model is required
    to submit. Raises ToolsUnsupported when the provider refuses function calling and LLMError
    when the model never submits a valid answer.
    """
    by_name = {t.name: t for t in tools}
    specs = [t.spec() for t in tools] + [{
        "type": "function",
        "function": {"name": submit_name, "description": submit_description,
                     "parameters": submit_schema},
    }]
    messages: List[Dict[str, Any]] = [{"role": "system", "content": system},
                                      {"role": "user", "content": user}]
    trace: List[Dict[str, Any]] = []
    for step in range(max_steps):
        last = step == max_steps - 1 or (deadline is not None and time.monotonic() > deadline)
        choice_arg: Any = {"type": "function", "function": {"name": submit_name}} if last else "auto"
        try:
            try:
                choice = complete(messages, max_tokens, tools=specs, tool_choice=choice_arg,
                                  temperature=temperature)
            except LLMError:
                raise
            except Exception as e:  # pylint: disable=broad-except
                if choice_arg == "auto" or not _is_bad_request(e):
                    raise
                # Some providers cannot force a named function: ask for it in words instead.
                messages.append({"role": "user", "content": f"Call `{submit_name}` now with "
                                 "your final answer."})
                choice = complete(messages, max_tokens, tools=specs, tool_choice="auto",
                                  temperature=temperature)
        except LLMError as e:
            raise LLMError(str(e), trace) from e
        except Exception as e:  # pylint: disable=broad-except
            if _is_bad_request(e) and step == 0:
                raise ToolsUnsupported(str(e)) from e
            raise LLMError(f"API call failed: {e}", trace) from e
        msg = choice.message
        calls = list(getattr(msg, "tool_calls", None) or [])
        if not calls:
            # A model that answers in text instead of calling submit: accept valid JSON,
            # otherwise ask again for the function call.
            content = msg.content or ""
            try:
                data = extract_json(content)
                problems = validate(data, submit_schema) + (on_submit(data) if on_submit else [])
                if not problems:
                    trace.append({"step": step + 1, "tool": submit_name, "summary": "submitted as text"})
                    return data, trace
            except ValueError:
                pass
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": f"Call the `{submit_name}` function with "
                             "your final answer."})
            continue
        messages.append({"role": "assistant", "content": msg.content or "",
                         "tool_calls": [_tool_call_dict(c) for c in calls]})
        submitted = None
        for call in calls:
            result, accepted = _execute_call(call, by_name, submit_name, submit_schema, on_submit)
            if accepted is not None:
                submitted = accepted
            trace.append({"step": step + 1, "tool": call.function.name, "summary": _summary(result)})
            messages.append({"role": "tool", "tool_call_id": call.id,
                             "content": json.dumps(result, ensure_ascii=False, default=str)})
        if submitted is not None:
            return submitted, trace
    raise LLMError(f"the model did not call {submit_name} with a valid answer "
                   f"after {max_steps} steps", trace)
