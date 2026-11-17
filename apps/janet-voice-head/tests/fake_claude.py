import json
import os
import queue
import sys
import threading
import time

argv = sys.argv[1:]
log_path = argv[argv.index("--fake-log") + 1]
resumed = "--resume" in argv
SESSION = "fake-session-" + str(os.getpid())
EMAIL = "owner@example.test"


def out(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def log(entry: dict) -> None:
    with open(log_path, "a", encoding="utf-8") as file:
        file.write(json.dumps(entry) + "\n")


def init() -> None:
    out({"type": "system", "subtype": "init", "session_id": SESSION, "mcp_servers": [],
         "tools": ["Bash"] if "--fake-leak-tools" in argv else []})


def reply_to(prompt: str) -> str:
    said = prompt.rsplit(" says: ", 1)[-1]
    if "conversation is over" in prompt:
        return "They talked about test things."
    if "order" in said:
        return f"I will pass that to main. <relay>\nask: {said}\ncommitment: main will handle it\n</relay>"
    if "count" in said:
        return " ".join(f"Number {n}." for n in range(1, 200))
    if "email" in said:
        return f"The account is {EMAIL}, I think."
    if "what did I hear" in said:
        return "You heard: " + (prompt.split('Only this much was heard: "', 1)[1].split('"', 1)[0] if "Only this much" in prompt else "everything") + "."
    return f"You said {said}. That is all I know."


log({"argv": argv, "cwd": os.getcwd(), "env": sorted(os.environ)})
incoming: queue.Queue = queue.Queue()


def read_stdin() -> None:
    for line in sys.stdin:
        incoming.put(json.loads(line))
    incoming.put(None)


threading.Thread(target=read_stdin, daemon=True).start()


def interrupt_waiting() -> bool:
    try:
        message = incoming.get_nowait()
    except queue.Empty:
        return False
    return message is not None and message["type"] == "control_request" and message["request"]["subtype"] == "interrupt"


while (message := incoming.get()) is not None:
    if message["type"] == "control_request" and message["request"]["subtype"] == "initialize":
        out({"type": "control_response", "response": {"response": {"account": {"email": EMAIL}}}})
        if resumed:
            init()
            out({"type": "result", "num_turns": 0})
    elif message["type"] == "user":
        prompt = message["message"]["content"]
        log({"prompt": prompt})
        init()
        out({"type": "system", "subtype": "status", "status": "requesting"})
        reply, aborted = reply_to(prompt), False
        for start in range(0, len(reply), 12):
            out({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": reply[start:start + 12]}}})
            if "count" in prompt:
                time.sleep(0.02)
                if aborted := interrupt_waiting():
                    break
        out({"type": "result", "terminal_reason": "aborted_streaming"} if aborted else {"type": "result", "num_turns": 1})
