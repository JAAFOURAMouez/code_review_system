"""Utility functions for mathematical operations and data processing."""

from __future__ import annotations

def calculate_factorial(n: int) -> int:
    """Calculate the factorial of a non‑negative integer.

    Parameters
    ----------
    n : int
        The number to calculate the factorial of. Must be non‑negative.

    Returns
    -------
    int
        The factorial of ``n``.

    Raises
    ------
    ValueError
        If ``n`` is negative.
    """
    if n < 0:
        raise ValueError("Factorial is not defined for negative numbers")
    result = 1
    for i in range(1, n + 1):
        result *= i
    return result


def process_data(data: list[int]) -> list[int]:
    """Return a new list with all zero values removed.

    Parameters
    ----------
    data : list[int]
        The input list of integers.

    Returns
    -------
    list[int]
        A new list containing only the non‑zero elements of ``data``.
    """
    return [item for item in data if item != 0]


def sum_positive_numbers(*numbers: int) -> int:
    """Return the sum of all positive numbers provided.

    Parameters
    ----------
    *numbers : int
        A variable number of integer arguments.

    Returns
    -------
    int
        The sum of all positive numbers.
    """
    return sum(n for n in numbers if n > 0)


if __name__ == "__main__":
    print(calculate_factorial(5))