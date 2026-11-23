import os
import sys

if __name__ == "__main__":
    launcher = "/opt/venv/bin/janet-phone"
    os.execv(launcher, [launcher, *sys.argv[1:]])
