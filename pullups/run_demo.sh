#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
export OMP_NUM_THREADS=2
export OPENBLAS_NUM_THREADS=2
exec .venv/bin/python demo_server.py "$@"
