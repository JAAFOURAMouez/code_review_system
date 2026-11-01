#!/usr/bin/env python3
"""
Test Generator Agent for the Code Review & Improvement System.
Uses Hugging Face Inference API to generate unit tests for code.
"""

import json
import os
import sys
import time
from typing import Dict, List, Any, Optional
from dotenv import load_dotenv

# Add the project root to the Python path so we can import from agents module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from agents.hf_client import generate_text

load_dotenv()  # Load environment variables from .env file

def generate_tests(code: str) -> Dict[str, Any]:
    """
    Generate unit tests for the given code.

    Args:
        code: The source code to analyze

    Returns:
        Dictionary with generated tests (as a string) and metadata
    """
    prompt = f"""You are an AI that generates unit tests. Given the following code, provide:
1. Unit tests for the functions and classes in the code.
2. Use appropriate testing frameworks (e.g., unittest for Python, Jest for JavaScript).
3. Include test cases for normal behavior and edge cases.

Format your response exactly as:

TESTS:
[generated test code]

If tests cannot be generated, write 'None' under TESTS.

Code:
{code}
"""

    try:
        response = generate_text(prompt, max_tokens=500, temperature=0.2, top_p=0.95)
        return parse_tests_response(response)
    except Exception as e:
        return {
            "tests": "",
            "error": True,
            "detail": str(e),
            "note": "Unable to generate tests due to API connectivity issues. Please check your network connection and HF_API_TOKEN."
        }

def parse_tests_response(response: str) -> Dict[str, Any]:
    """Parse the structured response from the LLM."""
    tests = ""

    # Split by sections
    if "TESTS:" in response:
        parts = response.split("TESTS:")
        tests_part = parts[1].strip()
        if tests_part and tests_part != "None":
            tests = tests_part

    return {
        "tests": tests
    }

def analyze_file(file_path: str) -> Dict[str, Any]:
    """
    Analyze a source code file to generate tests.

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
            "agent": "test_generator",
            "timestamp": time.time()
        }

    result = generate_tests(code)
    result.update({
        "file": file_path,
        "agent": "test_generator",
        "timestamp": time.time()
    })

    return result

def main():
    """Main entry point for the agent."""
    if len(sys.argv) < 2:
        print("Usage: python test_generator.py <file_path>")
        sys.exit(1)

    file_path = sys.argv[1]
    result = analyze_file(file_path)
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()