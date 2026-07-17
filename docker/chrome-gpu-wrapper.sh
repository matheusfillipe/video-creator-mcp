#!/bin/sh
# Force Chrome onto the AMD GPU via Vulkan/RADV. Chrome's default GL/ANGLE path fails to init on a
# headless AMD iGPU in this container and silently falls back to SwiftShader (software), which makes
# every Hyperframes html/GSAP render CPU-bound. Verified in-pod that `--use-angle=vulkan` brings up
# "AMD Radeon Graphics (RADV GFX1103_R1), radv" for both `chromium` and `chrome-headless-shell`.
#
# Hyperframes launches the real binaries via PUPPETEER_EXECUTABLE_PATH / PRODUCER_HEADLESS_SHELL_PATH;
# those point at this wrapper. It picks the matching real binary from its own name, strips the
# software-GL flags Hyperframes adds when its GPU probe fails (they would otherwise override the
# Vulkan backend), and re-launches with the Vulkan ANGLE backend forced.
case "$0" in
  *headless-shell*) REAL=/usr/local/bin/chrome-headless-shell.real ;;
  *) REAL=/usr/bin/chromium.real ;;
esac

# Rebuild the arg list without the software-GL flags (shift each original arg, re-append the keepers).
n=$#
while [ "$n" -gt 0 ]; do
  arg="$1"
  shift
  case "$arg" in
    --use-gl=* | --disable-gpu | --use-angle=swiftshader | --use-angle=gl) ;;
    *) set -- "$@" "$arg" ;;
  esac
  n=$((n - 1))
done

exec "$REAL" --use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist "$@"
