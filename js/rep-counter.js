// 計次狀態機：關鍵角度低於 downAngle 進入「下」，回到 upAngle 以上算完成一下。
// 兩個門檻之間是緩衝區，避免角度在門檻附近抖動造成重複計次。
export class RepCounter {
  constructor({ downAngle, upAngle, minRepMs = 400 }) {
    this.downAngle = downAngle;
    this.upAngle = upAngle;
    this.minRepMs = minRepMs;
    this.reset();
  }

  reset() {
    this.count = 0;
    this.state = 'waiting'; // waiting：還沒站好/撐好；up；down
    this.repStart = null;
    this.current = null; // 目前這一下的資料
  }

  // 每一幀呼叫一次；完成一下時回傳該次的資料，否則回傳 null
  update(keyAngle, timestamp, frame = {}) {
    if (!Number.isFinite(keyAngle)) return null;

    if (this.state === 'waiting') {
      if (keyAngle >= this.upAngle) this.state = 'up';
      return null;
    }

    if (this.state === 'up') {
      if (keyAngle < this.upAngle && this.current === null) {
        // 開始往下，開始記錄這一下
        this.current = { startTime: timestamp, minAngle: keyAngle, bottomTime: timestamp, frames: [] };
      }
      if (this.current) this.#record(keyAngle, timestamp, frame);
      if (keyAngle <= this.downAngle) {
        this.state = 'down';
      } else if (keyAngle >= this.upAngle && this.current) {
        // 沒蹲到 downAngle 就回去，不算一下，捨棄
        this.current = null;
      }
      return null;
    }

    // state === 'down'
    this.#record(keyAngle, timestamp, frame);
    if (keyAngle >= this.upAngle) {
      const rep = this.current;
      this.state = 'up';
      this.current = null;
      const durationMs = timestamp - rep.startTime;
      if (durationMs < this.minRepMs) return null;
      this.count += 1;
      return {
        index: this.count,
        minAngle: rep.minAngle,
        durationMs,
        descentMs: rep.bottomTime - rep.startTime,
        frames: rep.frames,
      };
    }
    return null;
  }

  #record(keyAngle, timestamp, frame) {
    const c = this.current;
    if (keyAngle < c.minAngle) {
      c.minAngle = keyAngle;
      c.bottomTime = timestamp;
    }
    c.frames.push({ t: timestamp, key: keyAngle, ...frame });
  }
}
