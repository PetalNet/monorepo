"""Write trained weights into a copy of the deployed hey_janet.tflite (identical graph, so the runtime can't tell
the difference), then prove parity against the PyTorch scores. Usage: patch_tflite.py weights.npz out.tflite"""
import os, sys, numpy as np, tflite
from ai_edge_litert.interpreter import Interpreter
BASE = os.environ.get("JANET_WW_BASELINE", "baseline/hey_janet.tflite")  # graph donor: the deployed model
from patch_tflite_map import MAP
W = np.load(sys.argv[1]); buf = bytearray(open(BASE, "rb").read())
m = tflite.Model.GetRootAsModel(buf, 0); g = m.Subgraphs(0)
eps = np.frombuffer(m.Buffers(g.Tensors(10).Buffer()).DataAsNumpy().tobytes(), np.float32)[0]
assert abs(eps - 1e-5) < 1e-9 or abs(eps - 1e-3) < 1e-9, eps
print("layernorm epsilon in graph", eps)
for ti, key in MAP.items():
    t = g.Tensors(ti); dst = m.Buffers(t.Buffer()).DataAsNumpy()
    src = np.ascontiguousarray(W[key].astype(np.float32)).reshape(t.ShapeAsNumpy()).tobytes()
    assert len(src) == len(dst), (key, len(src), len(dst)); dst[:] = np.frombuffer(src, np.uint8)
open(sys.argv[2], "wb").write(buf)
it = Interpreter(model_path=sys.argv[2]); it.allocate_tensors()
X, ref = W["probe_x"], W["probe_y"]; got = []
for x in X:
    it.set_tensor(it.get_input_details()[0]["index"], x[None].astype(np.float32)); it.invoke()
    got.append(it.get_tensor(it.get_output_details()[0]["index"])[0, 0])
d = np.abs(np.array(got) - ref).max(); print("parity max |tflite - torch| =", d); assert d < 1e-4
print("wrote", sys.argv[2])
