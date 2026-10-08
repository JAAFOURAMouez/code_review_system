#!/usr/bin/env python3
"""
Static Analysis Agent
Analyzes code using traditional linters and security scanners
"""
import json
import subprocess
import sys
import os
import redis
import time
from pathlib import Path

def run_pylint(file_path):
    """Run pylint and return JSON output"""
    try:
        result = subprocess.run([
            'pylint', 
            '--output-format=json', 
            file_path
        ], capture_output=True, text=True, timeout=30)
        
        if result.stdout:
            return json.loads(result.stdout)
        return []
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError) as e:
        print(f"Pylint error: {e}")
        return []

def run_flake8(file_path):
    """Run flake8 and return formatted output"""
    try:
        result = subprocess.run([
            'flake8',
            '--format=%(path)s:%(row)d:%(col)d: %(code)s %(text)s',
            file_path
        ], capture_output=True, text=True, timeout=30)
        
        findings = []
        for line in result.stdout.strip().split('\n'):
            if line:
                parts = line.split(':', 3)
                if len(parts) >= 4:
                    findings.append({
                        'type': 'flake8',
                        'file': parts[0],
                        'line': int(parts[1]),
                        'column': int(parts[2]),
                        'message': parts[3].strip(),
                        'severity': 'warning'
                    })
        return findings
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"Flake8 error: {e}")
        return []

def run_bandit(file_path):
    """Run bandit security scanner"""
    try:
        result = subprocess.run([
            'bandit',
            '-f', 'json',
            '-r', os.path.dirname(file_path) or '.'
        ], capture_output=True, text=True, timeout=30)
        
        if result.stdout:
            data = json.loads(result.stdout)
            findings = []
            for item in data.get('results', []):
                findings.append({
                    'type': 'bandit',
                    'file': item['filename'],
                    'line': item['line_number'],
                    'column': 1,  # Bandit doesn't provide column
                    'message': item['issue_text'],
                    'severity': item['issue_severity'].lower(),
                    'confidence': item['issue_confidence'].lower()
                })
            return findings
        return []
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError) as e:
        print(f"Bandit error: {e}")
        return []

def run_radon(file_path):
    """Run radon complexity analyzer"""
    try:
        result = subprocess.run([
            'radon', 'cc', '-j', file_path
        ], capture_output=True, text=True, timeout=30)
        
        if result.stdout:
            data = json.loads(result.stdout)
            findings = []
            for file_key, complexes in data.items():
                for complex_item in complexes:
                    findings.append({
                        'type': 'radon',
                        'file': file_key,
                        'line': complex_item['lineno'],
                        'column': 1,
                        'message': f"Complexity: {complex_item['type']} (score: {complex_item['complexity']})",
                        'severity': 'info' if complex_item['complexity'] <= 5 else 'warning',
                        'complexity_score': complex_item['complexity']
                    })
            return findings
        return []
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError) as e:
        print(f"Radon error: {e}")
        return []

def analyze_file(file_path):
    """Run all static analysis tools on a file"""
    if not os.path.exists(file_path):
        print(f"File not found: {file_path}")
        return []
    
    print(f"Analyzing {file_path}...")
    all_findings = []
    
    # Run each tool
    pylint_findings = run_pylint(file_path)
    for item in pylint_findings:
        all_findings.append({
            'type': 'pylint',
            'file': item.get('path'),
            'line': item.get('line'),
            'column': item.get('column'),
            'message': item.get('message'),
            'severity': item.get('type').lower() if item.get('type') in ['error', 'warning', 'refactor', 'convention'] else 'info',
            'symbol': item.get('symbol')
        })
    
    all_findings.extend(run_flake8(file_path))
    all_findings.extend(run_bandit(file_path))
    all_findings.extend(run_radon(file_path))
    
    return all_findings

def main():
    """Main agent loop"""
    # Connect to Redis
    try:
        r = redis.Redis(host='localhost', port=6379, db=0)
        r.ping()
        print("Connected to Redis")
    except redis.ConnectionError:
        print("Warning: Could not connect to Redis. Running in standalone mode.")
        r = None
    
    # If we have a file argument, analyze it once and exit
    if len(sys.argv) > 1:
        file_path = sys.argv[1]
        findings = analyze_file(file_path)
        
        # Output findings as JSON
        print(json.dumps({
            'file': file_path,
            'findings': findings,
            'timestamp': time.time(),
            'agent': 'static_analysis'
        }, indent=2))
        
        # If Redis is connected, also push to queue
        if r:
            r.lpush('static_analysis_results', json.dumps({
                'file': file_path,
                'findings': findings,
                'timestamp': time.time()
            }))
        return
    
    # Otherwise, listen for tasks from Redis
    print("Static Analysis Agent started. Waiting for tasks...")
    while True:
        try:
            # Block until a task is available
            _, task_json = r.brpop('static_analysis_tasks', timeout=1)
            task = json.loads(task_json)
            
            file_path = task.get('file')
            if file_path and os.path.exists(file_path):
                print(f"Processing task for {file_path}")
                findings = analyze_file(file_path)
                
                # Send results back
                r.lpush('static_analysis_results', json.dumps({
                    'file': file_path,
                    'findings': findings,
                    'timestamp': time.time(),
                    'task_id': task.get('task_id')
                }))
            else:
                print(f"File not found: {file_path}")
                
        except redis.ConnectionError:
            print("Lost connection to Redis. Retrying in 5 seconds...")
            time.sleep(5)
            try:
                r = redis.Redis(host='localhost', port=6379, db=0)
            except:
                pass
        except Exception as e:
            print(f"Error in static analysis agent: {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()
