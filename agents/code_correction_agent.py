#!/usr/bin/env python3
"""
Code Correction Agent for the Code Review & Improvement System.
Uses Hugging Face Inference API to generate corrected versions of code.
"""

import json
import os
import sys
import time
from typing import Dict, Any, Optional

# Add the project root to the Python path so we can import from agents module
project_root = os.path.join(os.path.dirname(__file__), '..')
sys.path.insert(0, project_root)

# Add virtual environment site-packages if exists
venv_path = os.path.join(project_root, '.venv')
if os.path.exists(venv_path):
    python_version = f"{sys.version_info.major}.{sys.version_info.minor}"
    site_packages = os.path.join(venv_path, 'lib', f'python{python_version}', 'site-packages')
    if os.path.exists(site_packages):
        sys.path.insert(0, site_packages)

from dotenv import load_dotenv
from agents.hf_client import generate_text

load_dotenv()  # Load environment variables from .env file

def correct_code(code: str) -> Dict[str, Any]:
    """
    Generate a corrected version of the given code.

    Args:
        code: The source code to correct

    Returns:
        Dictionary with corrected code and metadata
    """
    prompt = f"""You are an AI that corrects code. Given the following code, provide:
1. A corrected version that fixes all issues including:
   - PEP 8 style violations
   - Naming conventions (constants in UPPER_CASE, etc.)
   - Missing docstrings (module, function, class)
   - Potential bugs and security issues
   - Code complexity and readability issues
   - Unused variables and imports
   - Other code quality problems

2. Return ONLY the corrected code - no explanations, no extra text, no markdown formatting.
   If no corrections are needed, return the original code unchanged.

Code:
{code}
"""

    try:
        response = generate_text(prompt, max_tokens=800, temperature=0.1, top_p=0.95)
        # Extract just the code - remove any potential extra text
        corrected_code = response.strip()

        # If the response starts with markdown code blocks, extract the content
        if corrected_code.startswith("```python"):
            corrected_code = corrected_code[9:]  # Remove ```python
        if corrected_code.endswith("```"):
            corrected_code = corrected_code[:-3]  # Remove ```
        corrected_code = corrected_code.strip()

        return {
            "corrected_code": corrected_code
        }
    except Exception as e:
        return {
            "corrected_code": "",
            "error": True,
            "detail": str(e),
            "note": "Unable to generate corrected code due to API connectivity issues. Please check your network connection and HF_API_TOKEN."
        }

def analyze_file(file_path: str) -> Dict[str, Any]:
    """
    Analyze a source code file to generate corrected code.

    Args:
        file_path: Path to the source code file

    Returns:
        Analysis results in dictionary format
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            code = f.read()
    except IOError as e:
        return {
            "file": file_path,
            "error": f"Could not read file: {str(e)}",
            "agent": "code_correction",
            "timestamp": time.time()
        }

    result = correct_code(code)
    result.update({
        "file": file_path,
        "agent": "code_correction",
        "timestamp": time.time()
    })

    return result

def main():
    """Main entry point for the agent."""
    if len(sys.argv) < 2:
        print("Usage: python code_correction_agent.py <file_path>")
        sys.exit(1)

    file_path = sys.argv[1]
    result = analyze_file(file_path)
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()