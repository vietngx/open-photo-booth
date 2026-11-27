function boothDefaults(outputDir) {
  return {
    eventName: 'My Event', startText: 'Touch to start', cameraId: '', mirror: true, templateId: 'builtin:classic-strip', filter: 'none',
    countdown: 3, betweenShots: 2, reviewSeconds: 20, outputDir,
    printer: '', copies: 1, autoPrint: false, print2up: true, kiosk: false, pin: '',
  }
}

if (typeof module !== 'undefined') module.exports = boothDefaults
