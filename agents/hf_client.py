"""
Helper module for Hugging Face Inference Providers (OpenAI-compatible client).
Provides a shared client for text generation to avoid code duplication.
"""

import os
from typing import Optional
from dotenv import load_dotenv
from openai import OpenAI

# Load environment variables from .env file
load_dotenv()

# Get API token from environment
HF_API_TOKEN = os.getenv("HF_API_TOKEN")
if not HF_API_TOKEN:
    raise ValueError("HF_API_TOKEN environment variable not set")

# Get model from environment with fallback to default
HF_MODEL = os.getenv("HF_MODEL", "openai/gpt-oss-20b:groq")

# Initialize OpenAI-compatible client for Hugging Face Inference Providers
client = OpenAI(
    base_url="https://router.huggingface.co/v1",
    api_key=HF_API_TOKEN,
)

def generate_text(prompt: str, max_tokens: int = 500, temperature: float = 0.2, top_p: float = 0.95) -> str:
    """
    Generate text from a prompt using the Hugging Face Inference Providers API.

    Args:
        prompt: The input prompt for text generation
        max_tokens: Maximum number of tokens to generate
        temperature: Sampling temperature (0.0 to 1.0)
        top_p: Nucleus sampling parameter

    Returns:
        Generated text string

    Raises:
        Exception: If the API call fails for any reason
    """
    # Reasoning models (e.g. gpt-oss) spend part of max_tokens on hidden reasoning, so a small budget
    # can leave the visible answer empty. Use at least HF_MIN_TOKENS (default 4000).
    budget = max(max_tokens, int(os.getenv("HF_MIN_TOKENS", "2000")))
    # gpt-oss style models accept a reasoning effort; "low" leaves far more of the budget for the
    # visible answer. Set HF_REASONING_EFFORT= (empty) to disable, or to "medium"/"high".
    effort = os.getenv("HF_REASONING_EFFORT", "low").strip()
    extra = {"reasoning_effort": effort} if effort else None

    def call(tokens: int):
        nonlocal extra
        kwargs = dict(
            model=HF_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=tokens,
            temperature=temperature,
            top_p=top_p,
        )
        if extra:
            try:
                return client.chat.completions.create(**kwargs, extra_body=extra)
            except Exception:
                extra = None  # this model/provider does not accept it: stop sending it
        return client.chat.completions.create(**kwargs)

    try:
        # A reply cut off by the limit (finish_reason == "length") is incomplete, e.g. tests that stop
        # mid-function. Retry with a bigger budget (x2, then x4) before giving up.
        for attempt in range(3):
            choice = call(budget).choices[0]
            text = choice.message.content
            if choice.finish_reason != "length" and text and text.strip():
                return text
            if attempt < 2:
                budget *= 2
        raise ValueError(
            f"the model reply was {'empty' if not (text and text.strip()) else 'cut off'} "
            f"(finish_reason={choice.finish_reason}, max_tokens={budget}); "
            "raise HF_MIN_TOKENS or use a non-reasoning HF_MODEL"
        )
    except Exception as e:
        raise Exception(f"API call failed: {e}") from e
