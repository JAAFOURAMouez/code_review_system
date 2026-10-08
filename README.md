# Code Review & Improvement System

A multi-agent AI system for automated code review, analysis, and improvement suggestions.
Built entirely with free LLMs (via Hugging Face Inference Providers or local Ollama) and free APIs.

## System Overview

This system consists of five specialized agents that work together to analyze code:

1. **Static Analysis Agent** - Uses open-source linters (pylint, flake8, bandit, radon) to find bugs, style issues, security vulnerabilities, and code quality problems.
2. **Code Understanding Agent** - Uses an LLM to explain what the code does and identify complex sections.
3. **Improvement Suggestion Agent** - Uses an LLM to suggest refactorings, optimizations, and best practices.
4. **Test Generator Agent** - Uses an LLM to generate unit tests for the code.
5. **Documentation Agent** - Uses an LLM to generate documentation (docstrings, overview, usage examples).

## Components

- `agents/static_analysis.py` - Static analysis agent (requires pylint, flake8, bandit, radon)
- `agents/code_understanding.py` - LLM-powered code explanation agent
- `agents/improvement_suggestion.py` - LLM-powered improvement suggestion agent
- `agents/test_generator.py` - LLM-powered test generation agent
- `agents/documentation_agent.py` - LLM-powered documentation agent
- `agents/code_correction_agent.py` - LLM-powered code correction agent (uses Hugging Face Inference Providers)
- `orchestrator.py` - Runs all agents on a file and aggregates results
- `watcher.py` - Watches a directory for changes and triggers the orchestrator
- `src/sample.py` - Sample Python file with intentional issues for testing

## Setup

### Prerequisites

- Python 3.6+
- pip (Python package installer)

### Installation

1. Clone or copy this repository to your local machine.
2. Install the required Python packages for the static analysis agent:
   ```bash
   pip install pylint flake8 bandit radon
   ```
3. (Optional) Install watchdog for the file watcher:
   ```bash
   pip install watchdog
   ```
   If watchdog is not installed, the watcher will fall back to a polling mechanism.

4. Set up API access for the LLM-powered agents:
   - The LLM-powered agents use the Hugging Face Inference Providers by default.
   - Get a free API token from [Hugging Face](https://huggingface.co/settings/tokens).
   - Set the `HF_API_TOKEN` environment variable:
     ```bash
     export HF_API_TOKEN=your_hugging_face_token_here
     ```
   - Alternatively, you can modify the agents to use a local Ollama instance (see below).

### Using Local Ollama (Alternative to Hugging Face)

If you prefer to use a local LLM via Ollama instead of the Hugging Face API:

1. Install Ollama from [https://ollama.ai](https://ollama.ai) (follow the installation instructions for your platform).
2. Pull a code model, for example:
   ```bash
   ollama pull codellama:7b
   ```
3. Modify the LLM-powered agents to use Ollama instead of the Hugging Face API.
   - Replace the `call_huggingface_api` function with a function that calls the Ollama API.
   - The Ollama API endpoint is typically `http://localhost:11434/api/generate`.

## Usage

### Analyze a Single File

Run the orchestrator on a specific file:
```bash
python orchestrator.py path/to/your/file.py
```

### Watch for Changes

Start the file watcher to automatically analyze files when they change:
```bash
python watcher.py path/to/watch
```
Defaults to watching the `src` directory.

### Example Output

When you run the orchestrator on the included `src/sample.py` file, you should see output similar to:

```
Running Code Review & Improvement System on src/sample.py
============================================================
Running Static Analysis Agent...
  Static Analysis Agent: Completed successfully
Running Code Understanding Agent...
  Code Understanding Agent: Completed with errors
...
============================================================
AGGREGATED RESULTS
============================================================

--- STATIC_ANALYSIS ---
file: src/sample.py
findings: [...]
timestamp: ...
agent: static_analysis
```

## How It Works

1. The orchestrator runs each agent as a subprocess and collects their JSON output.
2. Each agent analyzes the input file and returns structured results.
3. The orchestrator prints a formatted summary of all results.
4. The file watcher monitors the target directory for file changes and automatically triggers the orchestrator.

## Extending the System

- Add more agents by following the pattern in the `agents/` directory.
- Modify the orchestrator to include additional agents.
- Change the file watcher to watch different file types or directories.
- Replace the Hugging Face API with other free LLM APIs or local models.

## Notes

- The LLM-powered agents require an API key for the Hugging Face Inference Providers (or a local LLM server).
- Without a valid API token or network access to the API, these agents will fall back to returning explanatory error messages.
- The static analysis agent does not require an API key and works offline once its dependencies are installed.
- For best results, ensure you have a valid Hugging Face token and network access to `api-inference.huggingface.co`.
- Note: The code correction agent has been fixed to properly import its dependencies. Ensure you have set the HF_API_TOKEN environment variable for the LLM-powered agents to work.

## License

This project is built for educational purposes and uses free and open-source tools.
