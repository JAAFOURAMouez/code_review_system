#!/usr/bin/env python3
"""
Code Understanding Agent for the Code Review & Improvement System.
Uses Hugging Face Inference API to explain code functionality and identify complex sections.
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

def explain_code(code: str) -> Dict[str, Any]:
    """
    Explain what the code does and identify complex sections.

    Args:
        code: The source code to analyze

    Returns:
        Dictionary with explanation and complex sections
    """
    prompt = f"""You are an AI that explains code. Given the following code, provide:
1. A clear explanation of what the code does.
2. A list of complex or hard-to-understand sections, each with the line number and a brief reason.

Format your response exactly as:

EXPLANATION:
[explanation text]

COMPLEX_SECTIONS:
- [line number]: [reason]
- [line number]: [reason]

If there are no complex sections, write 'None' under COMPLEX_SECTIONS.

Code:
{code}
"""

    try:
        response = generate_text(prompt, max_tokens=500, temperature=0.2, top_p=0.95)
        return parse_explanation_response(response)
    except Exception as e:
        return {
            "explanation": "Unable to generate explanation due to API connectivity issues. Please check your network connection and HF_API_TOKEN.",
            "complex_sections": [],
            "error": True,
            "detail": str(e)
        }

def parse_explanation_response(response: str) -> Dict[str, Any]:
    """Parse the structured response from the LLM."""
    explanation = ""
    complex_sections = []

    # Split by sections
    if "EXPLANATION:" in response and "COMPLEX_SECTIONS:" in response:
        parts = response.split("COMPLEX_SECTIONS:")
        explanation_part = parts[0].replace("EXPLANATION:", "").strip()
        explanation = explanation_part

        sections_part = parts[1].strip()
        if sections_part and sections_part != "None":
            lines = sections_part.split('\n')
            for line in lines:
                line = line.strip()
                if line.startswith('-'):
                    # Parse "- [line number]: [reason]"
                    content = line[1:].strip()
                    if ':' in content:
                        line_part, reason = content.split(':', 1)
                        line_num_str = line_part.strip()
                        reason = reason.strip()
                        try:
                            line_num = int(line_num_str)
                            complex_sections.append({
                                "line": line_num,
                                "reason": reason
                            })
                        except ValueError:
                            # If line number isn't an integer, skip or handle differently
                            pass
    else:
        # Fallback: treat entire response as explanation
        explanation = response.strip()

    return {
        "explanation": explanation,
        "complex_sections": complex_sections
    }

def analyze_file(file_path: str) -> Dict[str, Any]:
    """
    Analyze a source code file.

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
            "agent": "code_understanding",
            "timestamp": time.time()
        }

    result = explain_code(code)
    result.update({
        "file": file_path,
        "agent": "code_understanding",
        "timestamp": time.time()
    })

    return result

def main():
    """Main entry point for the agent."""
    if len(sys.argv) < 2:
        print("Usage: python code_understanding.py <file_path>")
        sys.exit(1)

    file_path = sys.argv[1]
    result = analyze_file(file_path)
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()