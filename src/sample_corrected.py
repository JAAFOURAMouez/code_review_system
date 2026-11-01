"""
Utility functions for factorial calculation, data processing, and summation.
"""

from __future__ import annotations

import os
from typing import Iterable, List


def calculate_factorial(n: int) -> int:
    """
    Calculate the factorial of a non‑negative integer.

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


def process_data(data: Iterable[int]) -> List[int]:
    """
    Return a new list with all zero values removed from the input iterable.

    Parameters
    ----------
    data : Iterable[int]
        The input data sequence.

    Returns
    -------
    List[int]
        A list containing all non‑zero elements from ``data``.
    """
    return [item for item in data if item != 0]


def get_password() -> str:
    """
    Retrieve the application password from the environment.

    Returns
    -------
    str
        The password value.

    Raises
    ------
    KeyError
        If the environment variable ``APP_PASSWORD`` is not set.
    """
    return os.environ["APP_PASSWORD"]


API_KEY = "sk-1234567890abcdef"

__all__ = [
    "calculate_factorial",
    "process_data",
    "get_password",
    "API_KEY",
]


def complex_function(*numbers: int