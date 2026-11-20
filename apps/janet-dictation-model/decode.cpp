#include <whisper.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

static uint32_t u32(const std::vector<unsigned char> &b, size_t i) {
    return uint32_t(b.at(i)) | (uint32_t(b.at(i + 1)) << 8) | (uint32_t(b.at(i + 2)) << 16) | (uint32_t(b.at(i + 3)) << 24);
}
static uint16_t u16(const std::vector<unsigned char> &b, size_t i) {
    return uint16_t(b.at(i)) | (uint16_t(b.at(i + 1)) << 8);
}
static std::vector<float> read_wav(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) throw std::runtime_error("cannot open WAV");
    std::vector<unsigned char> b((std::istreambuf_iterator<char>(file)), {});
    if (b.size() < 12 || std::string(b.begin(), b.begin() + 4) != "RIFF" || std::string(b.begin() + 8, b.begin() + 12) != "WAVE" || uint64_t(u32(b, 4)) + 8 != b.size()) throw std::runtime_error("invalid WAV container");
    bool format = false, data = false;
    std::vector<float> samples;
    for (size_t pos = 12; pos + 8 <= b.size();) {
        std::string name(b.begin() + pos, b.begin() + pos + 4);
        size_t len = u32(b, pos + 4), start = pos + 8;
        if (len > b.size() - start || len + (len & 1) > b.size() - start) throw std::runtime_error("invalid WAV chunk");
        if (name == "fmt ") {
            if (format || len < 16 || u16(b, start) != 1 || u16(b, start + 2) != 1 || u32(b, start + 4) != 16000 || u16(b, start + 12) != 2 || u16(b, start + 14) != 16) throw std::runtime_error("WAV must be PCM16, 16 kHz mono");
            format = true;
        } else if (name == "data") {
            if (data || len % 2) throw std::runtime_error("invalid WAV data");
            data = true;
            for (size_t i = start; i < start + len; i += 2) {
                int value = u16(b, i);
                samples.push_back((value < 32768 ? value : value - 65536) / 32768.0f);
            }
        }
        pos = start + len + (len & 1);
    }
    if (!format || !data || samples.empty() || samples.size() > 480000) throw std::runtime_error("WAV must contain 0 to 30 seconds of audio");
    return samples;
}
static std::string json_string(const std::string &s) {
    static const char *hex = "0123456789abcdef";
    std::string out = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { out += '\\'; out += char(c); }
        else if (c < 32) { out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; }
        else out += char(c);
    }
    return out + '"';
}
static void suppress(whisper_context *, whisper_state *, const whisper_token_data *, int, float *logits, void *user) {
    for (int id : *static_cast<std::vector<int> *>(user)) logits[id] = -std::numeric_limits<float>::infinity();
}
int main(int argc, char **argv) {
    try {
        std::string model, wav, prompt_file;
        int threads = 6;
        for (int i = 1; i < argc; ++i) {
            std::string arg = argv[i];
            if (i + 1 >= argc) throw std::runtime_error("missing argument value");
            std::string value = argv[++i];
            if (arg == "--model") model = value;
            else if (arg == "--wav") wav = value;
            else if (arg == "--prompt-file") prompt_file = value;
            else if (arg == "--threads") { size_t n; threads = std::stoi(value, &n); if (n != value.size() || threads < 1) throw std::runtime_error("invalid thread count"); }
            else throw std::runtime_error("unknown argument");
        }
        if (model.empty() || wav.empty()) throw std::runtime_error("--model and --wav are required");
        auto samples = read_wav(wav);
        std::string prompt;
        if (!prompt_file.empty()) {
            std::ifstream f(prompt_file, std::ios::binary);
            if (!f) throw std::runtime_error("cannot open prompt file");
            prompt.assign(std::istreambuf_iterator<char>(f), {});
            if (prompt.find('\0') != std::string::npos) throw std::runtime_error("prompt contains NUL");
        }
        auto cp = whisper_context_default_params();
        cp.use_gpu = false;
        whisper_context *ctx = whisper_init_from_file_with_params(model.c_str(), cp);
        if (!ctx) throw std::runtime_error("cannot load model");
        const std::vector<std::string> symbols = {"\"", "#", "(", ")", "*", "+", "/", ":", ";", "<", "=", ">", "[", "\\", "]", "^", "_", "`", "{", "|", "}", "~", "「", "」", "『", "』", "<<", ">>", "<<<", ">>>", "--", "---", "-(", "-[", "('", "(\"", "((", "))", "(((", ")))", "[[", "]]", "{{", "}}", "♪♪", "♪♪♪", "♩", "♪", "♫", "♬", "♭", "♮", "♯"};
        std::set<std::string> suppressed = {" -", " '"};
        for (const auto &s : symbols) { suppressed.insert(s); suppressed.insert(" " + s); }
        std::vector<int> ids;
        for (int i = 0; i < whisper_n_vocab(ctx); ++i) {
            const char *token = whisper_token_to_str(ctx, i);
            if (token && suppressed.count(token)) ids.push_back(i);
        }
        auto p = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
        p.print_progress = p.print_realtime = p.print_special = p.print_timestamps = false;
        p.n_threads = threads;
        p.max_tokens = 256;
        p.audio_ctx = std::max(160, std::min(1500, int(std::ceil(samples.size() / 320.0)) + 32));
        p.temperature_inc = 0;
        p.beam_search.beam_size = 5;
        p.greedy.best_of = 5;
        p.suppress_blank = false;
        p.no_timestamps = samples.size() < 16000 * 25;
        p.language = "en";
        p.initial_prompt = prompt.empty() ? nullptr : prompt.c_str();
        p.logits_filter_callback = suppress;
        p.logits_filter_callback_user_data = &ids;
        if (whisper_full(ctx, p, samples.data(), int(samples.size())) != 0) { whisper_free(ctx); throw std::runtime_error("inference failed"); }
        std::string text;
        int tokens = 0;
        bool cap = false;
        for (int i = 0; i < whisper_full_n_segments(ctx); ++i) {
            text += whisper_full_get_segment_text(ctx, i);
            int count = whisper_full_n_tokens(ctx, i);
            tokens += count;
            cap |= count >= p.max_tokens;
        }
        whisper_free(ctx);
        std::cout << "{\"text\":" << json_string(text) << ",\"audio_ctx\":" << p.audio_ctx << ",\"seconds\":" << samples.size() / 16000.0 << ",\"tokens\":" << tokens << ",\"max_tokens_reached\":" << (cap ? "true" : "false") << "}\n";
    } catch (const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
}
