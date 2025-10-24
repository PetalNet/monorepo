/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,js,svelte,ts}"],
  theme: {
    extend: {
      colors: {
        "theater-dark": "#1f1f2e", // Lighter background for better text contrast
        "theater-darker": "#16161f", // Lighter background for better text contrast
        "theater-purple": "#7c3aed", // Darker, more saturated purple (violet-600) for better contrast with white
        "theater-gold": "#fbbf24",
        "theater-silver": "#e5e7eb",
        "theater-bronze": "#c87941",
        // Override default grays for better contrast on dark backgrounds
        gray: {
          400: "#9ca3af", // default gray-400 (good contrast)
          500: "#9ca3af", // override gray-500 to use gray-400 for better contrast
          600: "#9ca3af", // override gray-600 to use gray-400 for better contrast
        },
      },
    },
  },
  plugins: [],
};
