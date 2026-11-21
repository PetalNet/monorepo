"""CPU retention for the OptimizedTurboVoice runtime's CUDA-only inference state."""

import types


class ResidentVoice:
    def __init__(self, model):
        self.model = model

    def _modules(self):
        return (self.model.enhancer, self.model.voice.t3, self.model.voice.s3gen, self.model.voice.ve)

    def offload(self):
        import torch
        from resemble_enhance.common import Normalizer

        model = self.model
        # The captured graph owns CUDA tensors outside Module parameters and buffers.
        model.voice.t3.inference_turbo = model.graph_decoder.fallback
        model.graph_decoder.graph.reset()
        del model.graph_decoder
        for module in model.enhancer.modules():
            if isinstance(module, Normalizer):
                del module.forward
                del module.inverse
        for module in self._modules():
            module.to("cpu")
        # S3Gen caches these positional encodings as ordinary tensor attributes.
        for embed in (model.voice.s3gen.flow.encoder.embed, model.voice.s3gen.flow.encoder.up_embed):
            embed.pos_enc.pe = embed.pos_enc.pe.to("cpu")
        model.voice.conds.to("cpu")
        # torch 2.8 retains an 8 MiB cuBLAS workspace per graph capture stream.
        torch._C._cuda_clearCublasWorkspaces()

    def reload(self):
        from graph_speech import GraphSpeechDecoder
        from resemble_enhance.common import Normalizer

        model = self.model
        for module in self._modules():
            module.to("cuda")
        model.voice.conds.to("cuda")
        for module in model.enhancer.modules():
            if isinstance(module, Normalizer):
                mean = module.running_mean.detach().clone()
                std = module.running_std.detach().clone()

                def forward(self, x, update=True, mean=mean, std=std):
                    return (x - mean) / std

                def inverse(self, x, mean=mean, std=std):
                    return x * std + mean

                module.forward = types.MethodType(forward, module)
                module.inverse = types.MethodType(inverse, module)
        model.graph_decoder = GraphSpeechDecoder(model.voice.t3)
        model.voice.t3.inference_turbo = model.graph_decoder
        return model
