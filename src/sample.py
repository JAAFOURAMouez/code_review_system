def calculate_factorial(n):
    """Calculate factorial of a number"""
    if n < 0:
        raise ValueError("Factorial is not defined for negative numbers")
    result = 1
    for i in range(1, n + 1):
        result *= i
    return result

def process_data(data):
    # Potential bug: modifying list while iterating
    for item in data:
        if item == 0:
            data.remove(item)  # BUG: Modifying list during iteration
    return data

# Security issue: hardcoded password
password = "admin123"
API_KEY = "sk-1234567890abcdef"

# Unused variable
unused_var = 42

def complex_function(a, b, c, d, e, f, g):
    # Too many parameters
    if a > 0:
        if b > 0:
            if c > 0:
                if d > 0:
                    if e > 0:
                        if f > 0:
                            if g > 0:
                                return a + b + c + d + e + f + g
    return 0

if __name__ == "__main__":
    print(calculate_factorial(5))
