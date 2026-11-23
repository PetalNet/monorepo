"""Score (N,16,96) feature windows with a .tflite openWakeWord head. Usage: score_tflite.py model.tflite in.npy out.npy"""
import sys, numpy as np
from ai_edge_litert.interpreter import Interpreter
it = Interpreter(model_path=sys.argv[1]); it.allocate_tensors()
i, o = it.get_input_details()[0]["index"], it.get_output_details()[0]["index"]
X = np.load(sys.argv[2], mmap_mode="r"); out = np.empty(len(X), np.float32)
for k in range(len(X)):
    it.set_tensor(i, np.asarray(X[k:k+1], np.float32)); it.invoke(); out[k] = it.get_tensor(o)[0, 0]
np.save(sys.argv[3], out); print("scored", len(X))
