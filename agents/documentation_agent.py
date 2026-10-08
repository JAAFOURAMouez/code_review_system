#!/usr/bin/env python3
"""
Documentation Agent for the Code Review & Improvement System.
Uses Hugging Face Inference API to generate documentation for code.
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

def generate_documentation(code: str) -> Dict[str, Any]:
    """
    Generate documentation for the given code.

    Args:
        code: The source code to analyze

    Returns:
        Dictionary with generated documentation (as a string) and metadata
    """
    prompt = f"""You are an AI that generates documentation. Given the following code, provide:
1. Docstrings for functions and classes.
2. A brief overview of what the code does.
3. Usage examples if appropriate.

Format your response exactly as:

DOCUMENTATION:
[generated documentation]

If documentation cannot be generated, write 'None' under DOCUMENTATION.

Code:
{code}
"""

    try:
        response = generate_text(prompt, max_tokens=500, temperature=0.2, top_p=0.95)
        return parse_documentation_response(response)
    except Exception as e:
        return {
            "documentation": "",
            "error": True,
            "note": "Unable to generate documentation due to API connectivity issues. Please check your network connection and HF_API_TOKEN."
        }

def parse_documentation_response(response: str) -> Dict[str, Any]:
    """Parse the structured response from the LLM."""
    documentation = ""

    # Split by sections
    if "DOCUMENTATION:" in response:
        parts = response.split("DOCUMENTATION:")
        doc_part = parts[1].strip()
        if doc_part and doc_part != "None":
            documentation = doc_part

    return {
        "documentation": documentation
    }

def analyze_file(file_path: str) -> Dict[str, Any]:
    """
    Analyze a source code file to generate documentation.

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
            "agent": "documentation_agent",
            "timestamp": time.time()
        }

    result = generate_documentation(code)
    result.update({
        "file": file_path,
        "agent": "documentation_agent",
        "timestamp": time.time()
    })

    return result

def main():
    """Main entry point for the agent."""
    if len(sys.argv) < 2:
        print("Usage: python documentation_agent.py <file_path>")
        sys.exit(1)

    file_path = sys.argv[1]
    result = analyze_file(file_path)
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()