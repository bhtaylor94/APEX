"""
Kalshi API Authentication Module.
Handles RSA-PSS request signing per Kalshi's API v2 specification.

Kalshi requires three headers on every authenticated request:
  - KALSHI-ACCESS-KEY: Your API Key ID
  - KALSHI-ACCESS-TIMESTAMP: Current time in milliseconds
  - KALSHI-ACCESS-SIGNATURE: RSA-PSS signature of (timestamp + method + path)
"""

import base64
import time

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


def load_private_key(file_path: str) -> rsa.RSAPrivateKey:
    """Load an RSA private key from a PEM file."""
    with open(file_path, "rb") as key_file:
        private_key = serialization.load_pem_private_key(
            key_file.read(),
            password=None,
            backend=default_backend(),
        )
    return private_key


def load_private_key_from_string(key_string: str) -> rsa.RSAPrivateKey:
    """Load an RSA private key from a PEM-formatted string."""
    private_key = serialization.load_pem_private_key(
        key_string.encode("utf-8"),
        password=None,
        backend=default_backend(),
    )
    return private_key


def sign_request(private_key: rsa.RSAPrivateKey, timestamp_ms: str, method: str, path: str) -> str:
    """
    Generate an RSA-PSS signature for a Kalshi API request.

    The message to sign is: timestamp_ms + HTTP_METHOD + path_without_query_params
    """
    # Strip query parameters from path before signing
    path_without_query = path.split("?")[0]
    message = f"{timestamp_ms}{method}{path_without_query}"

    signature = private_key.sign(
        message.encode("utf-8"),
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.DIGEST_LENGTH,
        ),
        hashes.SHA256(),
    )

    return base64.b64encode(signature).decode("utf-8")


def get_auth_headers(api_key: str, private_key: rsa.RSAPrivateKey, method: str, path: str) -> dict:
    """
    Generate the full set of authentication headers for a Kalshi API request.

    Args:
        api_key: Your Kalshi API Key ID
        private_key: Loaded RSA private key
        method: HTTP method (GET, POST, DELETE, etc.)
        path: API path (e.g., /trade-api/v2/portfolio/balance)

    Returns:
        Dictionary with KALSHI-ACCESS-KEY, KALSHI-ACCESS-SIGNATURE, KALSHI-ACCESS-TIMESTAMP
    """
    timestamp_ms = str(int(time.time() * 1000))

    signature = sign_request(private_key, timestamp_ms, method.upper(), path)

    return {
        "KALSHI-ACCESS-KEY": api_key,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestamp_ms,
        "Content-Type": "application/json",
    }
