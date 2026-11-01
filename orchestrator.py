#!/usr/bin/env python3
"""
Orchestrator for the Code Review & Improvement System.
Runs all agents on a given code file and aggregates the results.
"""

import json
import subprocess
import sys
import os
from typing import Dict, List, Any
from dotenv import load_dotenv

load_dotenv()  # Load environment variables from .env file

def get_python_executable():
    """Get the Python executable, preferring the venv if present."""
    venv_python = os.path.join(os.path.dirname(__file__), '.venv', 'bin', 'python')
    if os.path.isfile(venv_python):
        return venv_python
    return sys.executable

AGENTS = [
    {
        "name": "static_analysis",
        "script": "agents/static_analysis.py",
        "description": "Static Analysis Agent"
    },
    {
        "name": "code_understanding",
        "script": "agents/code_understanding.py",
        "description": "Code Understanding Agent"
    },
    {
        "name": "improvement_suggestion",
        "script": "agents/improvement_suggestion.py",
        "description": "Improvement Suggestion Agent"
    },
    {
        "name": "test_generator",
        "script": "agents/test_generator.py",
        "description": "Test Generator Agent"
    },
    {
        "name": "documentation_agent",
        "script": "agents/documentation_agent.py",
        "description": "Documentation Agent"
    },
    {
        "name": "code_correction",
        "script": "agents/code_correction_agent.py",
        "description": "Code Correction Agent"
    }
]

def run_agent(agent: Dict[str, str], file_path: str, env: Dict[str, str] = None) -> Dict[str, Any]:
    """Run a single agent and return its output."""
    try:
        result = subprocess.run(
            [get_python_executable(), agent["script"], file_path],
            capture_output=True,
            text=True,
            timeout=int(os.getenv("AGENT_TIMEOUT", "120")),
            env=env  # None = inherit this process's environment (the CLI default)
        )
        if result.returncode == 0:
            # Try to parse JSON output
            output = result.stdout.strip()
            # Try to parse as JSON directly
            try:
                return json.loads(output)
            except json.JSONDecodeError:
                # If direct parsing fails, try to extract JSON object from the output
                # Look for the first '{' and last '}' and try to parse that substring
                start = output.find('{')
                end = output.rfind('}')
                if start != -1 and end != -1 and start < end:
                    json_str = output[start:end+1]
                    try:
                        return json.loads(json_str)
                    except json.JSONDecodeError:
                        pass
                # If we still can't parse JSON, return error with raw output
                return {
                    "file": file_path,
                    "agent": agent["name"],
                    "error": True,
                    "raw_output": output,
                    "stderr": result.stderr
                }
        else:
            return {
                "file": file_path,
                "agent": agent["name"],
                "error": True,
                "returncode": result.returncode,
                "stderr": result.stderr
            }
    except subprocess.TimeoutExpired:
        return {
            "file": file_path,
            "agent": agent["name"],
            "error": True,
            "timeout": True
        }
    except Exception as e:
        return {
            "file": file_path,
            "agent": agent["name"],
            "error": True,
            "exception": str(e)
        }

def main():
    if len(sys.argv) < 2:
        print("Usage: python orchestrator.py <file_path>")
        sys.exit(1)

    file_path = sys.argv[1]

    if not os.path.isfile(file_path):
        print(f"Error: File '{file_path}' not found.")
        sys.exit(1)

    print(f"Running Code Review & Improvement System on {file_path}")
    print("=" * 60)

    results = []
    for agent in AGENTS:
        print(f"Running {agent['description']}...")
        result = run_agent(agent, file_path)
        results.append(result)
        # Print a brief status
        if result.get("error"):
            print(f"  {agent['description']}: Completed with errors")
        else:
            print(f"  {agent['description']}: Completed successfully")

    print("\n" + "=" * 60)
    print("AGGREGATED RESULTS")
    print("=" * 60)

    # Print each agent's result in a readable format
    for result in results:
        agent_name = result.get("agent", "unknown")
        print(f"\n--- {agent_name.upper()} ---")
        if result.get("error"):
            print(f"Error: {result.get('error')}")
            if "raw_output" in result:
                print(f"Raw output: {result['raw_output'][:200]}...")
            elif "stderr" in result:
                print(f"Stderr: {result['stderr'][:200]}...")
        else:
            # Pretty print the result, but limit large fields
            for key, value in result.items():
                if key in ["file", "agent", "timestamp"]:
                    print(f"{key}: {value}")
                elif isinstance(value, str) and len(value) > 200:
                    print(f"{key}: {value[:200]}... (truncated)")
                elif isinstance(value, list) and len(value) > 5:
                    print(f"{key}: {value[:5]}... (truncated, {len(value)} total)")
                else:
                    print(f"{key}: {value}")

            # Save corrected code to file if this is the code correction agent
            if agent_name == "code_correction" and "corrected_code" in result and result["corrected_code"]:
                corrected_code = result["corrected_code"]
                original_file = result.get("file", "unknown")
                if original_file != "unknown":
                    # Create corrected filename by adding _corrected before the extension
                    name, ext = os.path.splitext(original_file)
                    corrected_file = f"{name}_corrected{ext}"
                    try:
                        with open(corrected_file, 'w', encoding='utf-8') as f:
                            f.write(corrected_code)
                        print(f"\n💾 Corrected code saved to: {corrected_file}")
                    except Exception as e:
                        print(f"\n❌ Failed to save corrected code: {e}")

    # Optionally, save results to a file
    output_file = f"{file_path}_review_results.json"
    try:
        with open(output_file, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"\nFull results saved to {output_file}")
    except Exception as e:
        print(f"\nFailed to save results: {e}")

if __name__ == "__main__":
    main()