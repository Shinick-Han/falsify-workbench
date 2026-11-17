"""Launch the hosted runtime internal API: ``python -m hosted_runtime`` from app/local."""

from .http_api import main

if __name__ == '__main__':
    raise SystemExit(main())
