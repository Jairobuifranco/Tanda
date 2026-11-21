/**
 * TEAMU: THE GREAT PARCEL RACE - Shopping-Channel Live Announcer
 * Procedural commentary powered by SpeechSynthesis API with zero assets.
 */

class EsportsAnnouncer {
  constructor() {
    this.enabled = localStorage.getItem('announcer_enabled') !== 'false';
    this.synth = window.speechSynthesis || null;
    this.voice = null;
    this.lastSpokenTime = 0;
    this.lastLeaderId = null;
    this.minInterval = 4.5; // Minimum seconds between commentary lines to prevent overlapping
    this.queue = [];
    this.isSpeaking = false;

    this.initVoice();
  }

  initVoice() {
    if (!this.synth) return;
    const setVoice = () => {
      const voices = this.synth.getVoices();
      // Prefer energetic English voices
      const preferred = ['Daniel', 'Samantha', 'Google US English', 'Alex', 'Karen', 'Moira'];
      for (const p of preferred) {
        const found = voices.find(v => v.name.includes(p) && v.lang.startsWith('en'));
        if (found) {
          this.voice = found;
          break;
        }
      }
      if (!this.voice) {
        this.voice = voices.find(v => v.lang.startsWith('en')) || voices[0];
      }
    };

    setVoice();
    if (this.synth.onvoiceschanged !== undefined) {
      this.synth.onvoiceschanged = setVoice;
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('announcer_enabled', this.enabled);
    if (!this.enabled && this.synth) {
      this.synth.cancel();
      this.queue = [];
      this.isSpeaking = false;
    }
    return this.enabled;
  }

  speak(text, priority = false) {
    if (!this.enabled || !this.synth) return;

    const now = Date.now() * 0.001;
    if (this.synth.speaking && now - this.lastSpokenTime > 8) {
      this.synth.cancel();
      this.isSpeaking = false;
    }

    if (!priority && (now - this.lastSpokenTime < this.minInterval || this.isSpeaking)) {
      return;
    }

    if (priority) {
      this.synth.cancel();
      this.queue = [];
      this.isSpeaking = false;
    }

    const utter = new SpeechSynthesisUtterance(text);
    if (this.voice) utter.voice = this.voice;
    utter.rate = 1.15; // Energetic esports pace
    utter.pitch = 1.05;
    utter.volume = 0.9;
    this.currentUtterance = utter;

    utter.onstart = () => {
      this.isSpeaking = true;
      this.lastSpokenTime = Date.now() * 0.001;
    };
    utter.onend = () => {
      this.isSpeaking = false;
      this.currentUtterance = null;
    };
    utter.onerror = () => {
      this.isSpeaking = false;
      this.currentUtterance = null;
    };

    try {
      this.synth.speak(utter);
    } catch (e) {
      console.warn('Speech synthesis error:', e);
    }
  }

  // --------------------------------------------------------------------------
  // Dynamic Game Event Callouts
  // --------------------------------------------------------------------------
  onRaceStart() {
    const lines = [
      "The sale is LIVE! Three, two, one... start shopping!",
      "Doors are open! Parcels are rolling out of the warehouse!",
      "Prices are dropping and the parcels are off! Two minutes to get delivered!"
    ];
    this.speak(lines[Math.floor(Math.random() * lines.length)], true);
  }

  onLeaderChange(leaderName, leaderId) {
    if (leaderId === this.lastLeaderId) return;
    this.lastLeaderId = leaderId;

    const lines = [
      `${leaderName} takes the lead!`,
      `${leaderName} is out for delivery and leading the pack!`,
      `Hot deal! ${leaderName} pulls out in front!`
    ];
    this.speak(lines[Math.floor(Math.random() * lines.length)]);
  }

  onWarp(racerName, holeName, isTopRacer = false) {
    if (isTopRacer) {
      const topLines = [
        `Oh no! The leader, ${racerName}, is stuck at ${holeName}!`,
        `Delivery delayed! ${racerName} just got rerouted by ${holeName}!`
      ];
      this.speak(topLines[Math.floor(Math.random() * topLines.length)], true);
      return;
    }

    const lines = [
      `${racerName} got held at ${holeName}!`,
      `Package rerouted! ${racerName} is going the long way round!`,
      `${racerName} just found out about ${holeName}!`
    ];
    this.speak(lines[Math.floor(Math.random() * lines.length)]);
  }

  onCloseToGoal(racerName) {
    const lines = [
      `${racerName} is out for delivery, just a few aisles away!`,
      `${racerName} can almost ring the doorbell!`
    ];
    this.speak(lines[Math.floor(Math.random() * lines.length)]);
  }

  onMegaCoupon(racerName) {
    const lines = [
      `Cha-ching! ${racerName} grabbed a ten dollar mega coupon!`,
      `What a bargain! ${racerName} scores the mega coupon!`
    ];
    this.speak(lines[Math.floor(Math.random() * lines.length)]);
  }

  onFirstPlaceFinish(racerName, timeStr) {
    const lines = [
      `DELIVERED! ${racerName} reaches the door first in ${timeStr} seconds!`,
      `Ding dong! ${racerName}'s parcel has arrived! First place!`
    ];
    this.speak(lines[Math.floor(Math.random() * lines.length)], true);
  }

  onSecondPlaceFinish(racerName) {
    this.speak(`Second delivery of the day goes to ${racerName}!`);
  }

  onThirdPlaceFinish(racerName) {
    this.speak(`${racerName} is delivered in third! The podium is set!`);
  }

  onFinalCountdown(seconds) {
    if (seconds === 30) {
      this.speak("Hurry! Only thirty seconds left on this deal!", true);
    } else if (seconds === 10) {
      this.speak("Ten seconds! The sale is almost over!", true);
    }
  }

  onRaceOver(podium) {
    if (podium && podium.length > 0) {
      const champ = podium[0].name;
      this.speak(`The sale is over! Congratulations to our top shopper, ${champ}!`, true);
    } else {
      this.speak("The sale is over! Not a single parcel made it to the door!", true);
    }
  }
}

window.announcer = new EsportsAnnouncer();
