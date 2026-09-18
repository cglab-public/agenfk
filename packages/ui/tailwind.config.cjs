module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: 'class',
  theme: {
    extend: {
      keyframes: {
        // Opacity only. A backdrop that also moves competes with the dialog
        // growing on top of it.
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        // Transform and opacity only — both composited, so neither triggers
        // layout. The scale is deliberately small: a modal that leaps in reads
        // as a notification rather than as the thing you just asked for.
        popIn: {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },},
  },
  plugins: [],
}
