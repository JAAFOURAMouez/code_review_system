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
    try:
        completion = client.chat.completions.create(
            model=HF_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
        )
        return completion.choices[0].message.content
    except Exception as e:
        raise Exception(f"API call failed: {e}") from e