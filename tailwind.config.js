/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,js,svelte,ts}"],
  theme: {
    extend: {
      colors: {
        // Layered surfaces with depth
        "theater-background": "#0B0B0F", // Deep background
        "theater-dark": "#16161A", // Elevated panels
        "theater-darker": "#0B0B0F", // Background (keeping for compatibility)
        "theater-elevated": "#222226", // High-contrast overlays

        // Stage lights - purple as accent, not background
        "theater-purple": "#7c3aed", // Primary (violet-600) - for buttons
        "theater-purple-light": "#a78bfa", // Text on dark (violet-400)
        "theater-purple-glow": "#8b5cf6", // Glow/spotlight effect

        // Accent motion - energy states
        "theater-teal": "#14b8a6", // Active state
        "theater-amber": "#f59e0b", // Warning/urgent
        "theater-gold": "#fbbf24", // Success/winner

        // Existing
        "theater-silver": "#e5e7eb",
        "theater-bronze": "#c87941",

        // Override default grays for better contrast on dark backgrounds
        gray: {
          400: "#9ca3af",
          500: "#9ca3af",
          600: "#9ca3af",
        },
      },
      animation: {
        "fade-in": "fadeIn 0.5s cubic-bezier(0.4, 0, 0.2, 1)",
        "slide-up": "slideUp 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
        "slide-in": "slideIn 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
        "glow-pulse": "glowPulse 2s ease-in-out infinite",
        "spotlight-sweep": "spotlightSweep 12s ease-in-out infinite",
        "spotlight-roam": "spotlightRoam 20s ease-in-out infinite",
        float: "float 3s ease-in-out infinite",
        confetti: "confetti 3s ease-out forwards",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { transform: "translateY(20px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        slideIn: {
          "0%": { transform: "translateX(-20px)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        glowPulse: {
          "0%, 100%": {
            boxShadow: "0 0 20px rgba(139, 92, 246, 0.3)",
          },
          "50%": {
            boxShadow:
              "0 0 40px rgba(139, 92, 246, 0.6), 0 0 60px rgba(139, 92, 246, 0.3)",
          },
        },
        spotlightSweep: {
          "0%, 100%": {
            transform: "translateX(-50%) rotate(-15deg)",
            opacity: "0.4",
          },
          "50%": {
            transform: "translateX(50%) rotate(15deg)",
            opacity: "0.6",
          },
        },
        spotlightRoam: {
          "0%": {
            transform: "translate(10vw, 20vh) scale(1)",
            opacity: "1",
          },
          "20%": {
            transform: "translate(80vw, 10vh) scale(1.3)",
            opacity: "1",
          },
          "40%": {
            transform: "translate(70vw, 70vh) scale(0.9)",
            opacity: "1",
          },
          "60%": {
            transform: "translate(20vw, 80vh) scale(1.1)",
            opacity: "1",
          },
          "80%": {
            transform: "translate(50vw, 40vh) scale(1.2)",
            opacity: "1",
          },
          "100%": {
            transform: "translate(10vw, 20vh) scale(1)",
            opacity: "1",
          },
        },
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-10px)" },
        },
        confetti: {
          "0%": { transform: "translateY(0) rotate(0deg)", opacity: "1" },
          "100%": {
            transform: "translateY(100vh) rotate(720deg)",
            opacity: "0",
          },
        },
      },
      boxShadow: {
        "glow-sm": "0 0 10px rgba(139, 92, 246, 0.3)",
        glow: "0 0 20px rgba(139, 92, 246, 0.4)",
        "glow-lg":
          "0 0 30px rgba(139, 92, 246, 0.5), 0 0 60px rgba(139, 92, 246, 0.2)",
        stage:
          "0 10px 40px rgba(0, 0, 0, 0.6), 0 0 80px rgba(139, 92, 246, 0.15)",
        elevated: "0 8px 24px rgba(0, 0, 0, 0.4)",
      },
    },
  },
  plugins: [],
};
