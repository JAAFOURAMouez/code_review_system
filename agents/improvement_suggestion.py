#!/usr/bin/env python3
"""
Improvement Suggestion Agent for the Code Review & Improvement System.
Uses Hugging Face Inference API to suggest code improvements.
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

def suggest_improvements(code: str) -> Dict[str, Any]:
    """
    Suggest improvements for the given code.

    Args:
        code: The source code to analyze

    Returns:
        Dictionary with improvement suggestions
    """
    prompt = f"""You are an AI that suggests code improvements. Given the following code, provide:
1. A list of specific improvements (refactoring, best practices, performance, etc.)
2. For each improvement, provide the line number (if applicable) and a description.

Format your response exactly as:

IMPROVEMENTS:
- [line number]: [description]
- [line number]: [description]

If there are no improvements, write 'None' under IMPROVEMENTS.

Code:
{code}
"""

    try:
        response = generate_text(prompt, max_tokens=500, temperature=0.2, top_p=0.95)
        return parse_improvements_response(response)
    except Exception as e:
        return {
            "improvements": [],
            "error": True,
            "note": "Unable to generate suggestions due to API connectivity issues. Please check your network connection and HF_API_TOKEN."
        }

def parse_improvements_response(response: str) -> Dict[str, Any]:
    """Parse the structured response from the LLM."""
    improvements = []

    # Split by sections
    if "IMPROVEMENTS:" in response:
        parts = response.split("IMPROVEMENTS:")
        sections_part = parts[1].strip()
        if sections_part and sections_part != "None":
            lines = sections_part.split('\n')
            for line in lines:
                line = line.strip()
                if line.startswith('-'):
                    # Parse "- [line number]: [description]"
                    content = line[1:].strip()
                    if ':' in content:
                        line_part, description = content.split(':', 1)
                        line_num_str = line_part.strip()
                        description = description.strip()
                        try:
                            line_num = int(line_num_str)
                            improvements.append({
                                "line": line_num,
                                "description": description
                            })
                        except ValueError:
                            # If line number isn't an integer, skip or handle differently
                            pass
    # If no improvements section or none found, return empty list

    return {
        "improvements": improvements
    }

def analyze_file(file_path: str) -> Dict[str, Any]:
    """
    Analyze a source code file for improvement suggestions.

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
            "agent": "improvement_suggestion",
            "timestamp": time.time()
        }

    result = suggest_improvements(code)
    result.update({
        "file": file_path,
        "agent": "improvement_suggestion",
        "timestamp": time.time()
    })

    return result

def main():
    """Main entry point for the agent."""
    if len(sys.argv) < 2:
        print("Usage: python improvement_suggestion.py <file_path>")
        sys.exit(1)

    file_path = sys.argv[1]
    result = analyze_file(file_path)
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()