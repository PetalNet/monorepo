"""Read the deployed head's weights out of its .tflite into an npz (inverse of patch_tflite.py). Usage: extract_tflite.py model.tflite out.npz"""
import sys, numpy as np, tflite
from patch_tflite_map import MAP
buf = bytearray(open(sys.argv[1], "rb").read()); m = tflite.Model.GetRootAsModel(buf, 0); g = m.Subgraphs(0)
W = {}
for ti, key in MAP.items():
    t = g.Tensors(ti); W[key] = np.frombuffer(m.Buffers(t.Buffer()).DataAsNumpy().tobytes(), np.float32).reshape(t.ShapeAsNumpy()).copy()
W["last_layer.bias"] = W["last_layer.bias"].reshape(1); W["last_layer.weight"] = W["last_layer.weight"].reshape(1, -1)
for k in ("layernorm1.weight", "layernorm1.bias", "blocks.0.layer_norm.weight", "blocks.0.layer_norm.bias"): W[k] = W[k].reshape(-1)
np.savez(sys.argv[2], **W); print({k: v.shape for k, v in W.items()})
