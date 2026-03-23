# Example: Python script with # %% cell separators
#
# Open this file in Cursor, attach a Colab session, then:
#   Ctrl+Shift+Enter  → run selected cell
#   Cmd Palette → "Notebook Bridge: Push Notebook to Remote"
#   Cmd Palette → "Notebook Bridge: Pull Notebook from Remote"

# %% [markdown]
# # Hello Colab from Cursor
# This notebook was pushed from a `.py` script via Cursor Notebook Bridge.

# %% Imports
import sys
print(f"Python {sys.version}")

# %% Check GPU
import subprocess
result = subprocess.run(["nvidia-smi"], capture_output=True, text=True)
if result.returncode == 0:
    print(result.stdout)
else:
    print("No GPU detected (or nvidia-smi not available)")

# %% Simple computation
import math

def prime_sieve(n: int) -> list[int]:
    sieve = [True] * (n + 1)
    sieve[0] = sieve[1] = False
    for i in range(2, int(math.sqrt(n)) + 1):
        if sieve[i]:
            for j in range(i * i, n + 1, i):
                sieve[j] = False
    return [i for i, is_prime in enumerate(sieve) if is_prime]

primes = prime_sieve(1000)
print(f"Found {len(primes)} primes up to 1000. Last 5: {primes[-5:]}")

# %% Install a package
# !pip install rich

# %% Use the installed package
from rich.table import Table
from rich.console import Console

console = Console()
table = Table(title="First 10 Primes")
table.add_column("Index", style="cyan")
table.add_column("Prime", style="green")

for i, p in enumerate(primes[:10]):
    table.add_row(str(i + 1), str(p))

console.print(table)
