// =====================================================================
//  CH340 (WCH USB-to-Serial) WebUSB 드라이버
//  참고 소스:
//    - mik3y/usb-serial-for-android :: Ch34xSerialDriver.java  (MIT)
//    - Linux kernel :: drivers/usb/serial/ch341.c              (GPL 참고용)
//  Web Serial API의 SerialPort 인터페이스를 CH340 벤더 프로토콜로 구현.
//  window.ch340Serial 로 노출 — navigator.serial 과 호환되는 requestPort/getPorts 제공.
// =====================================================================
(function (global) {
  'use strict';

  // ── CH340 식별 ─────────────────────────────────────────────────────
  const CH340_VID = 0x1a86;                       // WCH
  const CH340_PIDS = [0x7523, 0x5523, 0x7522];    // CH340, CH341, CH340K

  // ── 벤더 컨트롤 전송 요청 ─────────────────────────────────────────
  const CMD_READ_VERSION = 0x5F;   // IN
  const CMD_READ_REG     = 0x95;   // IN
  const CMD_WRITE_REG    = 0x9A;   // OUT
  const CMD_SERIAL_INIT  = 0xA1;   // OUT
  const CMD_MODEM_OUT    = 0xA4;   // OUT

  // ── Line Control 비트 (0x9A, 0x2518, LCR) ─────────────────────────
  const LCR_ENABLE_RX    = 0x80;
  const LCR_ENABLE_TX    = 0x40;
  const LCR_MARK_SPACE   = 0x20;
  const LCR_PAR_EVEN     = 0x10;
  const LCR_ENABLE_PAR   = 0x08;
  const LCR_STOP_BITS_2  = 0x04;
  const LCR_CS8          = 0x03;
  const LCR_CS7          = 0x02;
  const LCR_CS6          = 0x01;
  const LCR_CS5          = 0x00;

  // ── MODEM_OUT (bit-inverted): DTR=0x20, RTS=0x40 ─────────────────
  const MODEM_DTR = 0x20;
  const MODEM_RTS = 0x40;

  // ── 로그 헬퍼 (개발자 도구용) ─────────────────────────────────────
  const log = (...args) => console.log('[CH340]', ...args);
  const warn = (...args) => console.warn('[CH340]', ...args);

  // ─────────────────────────────────────────────────────────────────
  //  Ch340Port — Web Serial의 SerialPort 인터페이스를 모방
  // ─────────────────────────────────────────────────────────────────
  class Ch340Port {
    constructor(usbDevice) {
      this._device = usbDevice;
      this._interfaceNumber = 0;
      this._configurationValue = 1;
      this._epIn = null;
      this._epOut = null;
      this._readable = null;
      this._writable = null;
      this._dtr = false;
      this._rts = false;
      this._opened = false;
    }

    getInfo() {
      return {
        usbVendorId: this._device.vendorId,
        usbProductId: this._device.productId,
      };
    }

    get readable() { return this._readable; }
    get writable() { return this._writable; }

    // -------- 내부: 컨트롤 전송 --------
    async _controlIn(request, value, index, length) {
      const r = await this._device.controlTransferIn({
        requestType: 'vendor',
        recipient: 'device',
        request, value, index,
      }, length);
      const bytes = new Uint8Array(r.data.buffer);
      log(`ctrlIn  req=0x${request.toString(16)} val=0x${value.toString(16)} idx=0x${index.toString(16)} → [${Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join(' ')}] (${r.status})`);
      return bytes;
    }

    async _controlOut(request, value, index) {
      const r = await this._device.controlTransferOut({
        requestType: 'vendor',
        recipient: 'device',
        request, value, index,
      });
      log(`ctrlOut req=0x${request.toString(16)} val=0x${value.toString(16)} idx=0x${index.toString(16)} (${r.status})`);
      return r;
    }

    // -------- open --------
    async open(options) {
      const {
        baudRate = 9600,
        dataBits = 8,
        stopBits = 1,
        parity = 'none',
      } = options || {};

      if (!this._device.opened) {
        await this._device.open();
      }
      if (this._device.configuration === null) {
        await this._device.selectConfiguration(this._configurationValue);
      }
      await this._device.claimInterface(this._interfaceNumber);

      // 벌크 엔드포인트 탐색
      const iface = this._device.configuration.interfaces
        .find(i => i.interfaceNumber === this._interfaceNumber);
      if (!iface) throw new Error('CH340: interface 0을 찾지 못함');
      const alt = iface.alternate;
      for (const ep of alt.endpoints) {
        if (ep.type === 'bulk') {
          if (ep.direction === 'in') this._epIn = ep.endpointNumber;
          else this._epOut = ep.endpointNumber;
        }
      }
      if (this._epIn === null || this._epOut === null) {
        throw new Error('CH340: 벌크 엔드포인트를 찾지 못함');
      }
      log(`endpoints: IN=${this._epIn}, OUT=${this._epOut}`);

      // === 초기화 시퀀스 (Ch34xSerialDriver.java 기반) ===
      const lcr = this._computeLcr(dataBits, stopBits, parity);
      log(`init: baud=${baudRate}, lcr=0x${lcr.toString(16)}`);

      // 1) 버전 읽기 (일종의 ping)
      await this._controlIn(CMD_READ_VERSION, 0x0000, 0x0000, 8);
      // 2) 시리얼 초기화
      await this._controlOut(CMD_SERIAL_INIT, 0x0000, 0x0000);
      // 3) 첫 baud 설정
      await this._setBaudRate(baudRate);
      // 4) line control 기록
      await this._controlOut(CMD_WRITE_REG, 0x2518, lcr);
      // 5) 상태 확인
      await this._controlIn(CMD_READ_REG, 0x2518, 0x0000, 2);
      // 6) 두 번째 초기화 (Ch34xSerialDriver의 "init #6")
      await this._controlOut(CMD_SERIAL_INIT, 0x501F, 0xD90A);
      // 7) baud 재적용
      await this._setBaudRate(baudRate);
      // 8) MODEM_OUT (DTR/RTS 반영)
      await this._applyModem();
      // 9) 마지막 상태 확인
      await this._controlIn(CMD_READ_REG, 0x0706, 0x0000, 2);

      this._opened = true;
      this._makeStreams();
      log('open 완료');
    }

    // -------- close --------
    async close() {
      this._opened = false;
      try { if (this._readable) await this._readable.cancel(); } catch (_) {}
      try { if (this._writable) await this._writable.close(); } catch (_) {}
      this._readable = null;
      this._writable = null;
      try { await this._device.releaseInterface(this._interfaceNumber); } catch (_) {}
      // 참고: device.close()는 하지 않음 — WebUSB 승인 상태를 유지하려면 열어둠.
    }

    // -------- setSignals --------
    async setSignals(signals) {
      if (signals.dataTerminalReady !== undefined) this._dtr = !!signals.dataTerminalReady;
      if (signals.requestToSend       !== undefined) this._rts = !!signals.requestToSend;
      await this._applyModem();
    }

    async _applyModem() {
      // Ch34xSerialDriver: value = ~((dtr?0x20:0) | (rts?0x40:0)) & 0xFF
      // bit-inverted: bit=0 이면 해당 신호 ON, bit=1 이면 OFF.
      let val = 0xFF;
      if (this._dtr) val &= ~MODEM_DTR;
      if (this._rts) val &= ~MODEM_RTS;
      await this._controlOut(CMD_MODEM_OUT, val & 0xFF, 0x0000);
    }

    // -------- Line Control 계산 --------
    _computeLcr(dataBits, stopBits, parity) {
      let lcr = LCR_ENABLE_RX | LCR_ENABLE_TX;
      switch (dataBits) {
        case 5: lcr |= LCR_CS5; break;
        case 6: lcr |= LCR_CS6; break;
        case 7: lcr |= LCR_CS7; break;
        case 8: default: lcr |= LCR_CS8; break;
      }
      if (parity === 'odd')   lcr |= LCR_ENABLE_PAR;
      if (parity === 'even')  lcr |= LCR_ENABLE_PAR | LCR_PAR_EVEN;
      if (parity === 'mark')  lcr |= LCR_ENABLE_PAR | LCR_MARK_SPACE;
      if (parity === 'space') lcr |= LCR_ENABLE_PAR | LCR_MARK_SPACE | LCR_PAR_EVEN;
      if (stopBits === 2)     lcr |= LCR_STOP_BITS_2;
      return lcr;
    }

    // -------- Baud Rate 설정 --------
    async _setBaudRate(baudRate) {
      const divisors = this._getBaudDivisors(baudRate);
      if (!divisors) throw new Error(`CH340: 지원하지 않는 baud rate ${baudRate}`);
      const [div, ext] = divisors;
      log(`setBaud ${baudRate} → div=0x${div.toString(16)}, ext=0x${ext.toString(16)}`);
      // reg 0x1312 = divisor 부분, reg 0x0F2C = LSB
      await this._controlOut(CMD_WRITE_REG, 0x1312, div);
      await this._controlOut(CMD_WRITE_REG, 0x0F2C, ext);
    }

    _getBaudDivisors(baudRate) {
      // Ch34xSerialDriver.getBaudDivisor 이식.
      if (baudRate === 921600) return [0x7F, 0xF3];
      let factor = Math.floor(1532620800 / baudRate);
      let divisor = 3;
      while (factor > 0xFFF0 && divisor > 0) {
        factor >>= 3;
        divisor--;
      }
      if (factor > 0xFFF0) return null;
      factor = 0x10000 - factor;
      const div = (factor & 0xFF00) | divisor;
      const lcr = factor & 0xFF;
      return [div, lcr];
    }

    // -------- Streams --------
    _makeStreams() {
      const device = this._device;
      const epIn = this._epIn;
      const epOut = this._epOut;

      this._readable = new ReadableStream({
        pull: async (controller) => {
          if (!this._opened) { controller.close(); return; }
          try {
            const result = await device.transferIn(epIn, 64);
            if (result.status === 'stall') {
              warn('IN 엔드포인트 stall — clearHalt');
              await device.clearHalt('in', epIn);
              return;
            }
            if (result.data && result.data.byteLength > 0) {
              controller.enqueue(new Uint8Array(result.data.buffer.slice(0)));
            }
          } catch (e) {
            if (this._opened) controller.error(e);
            else controller.close();
          }
        },
        cancel: () => { this._opened = false; },
      });

      this._writable = new WritableStream({
        write: async (chunk) => {
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          const result = await device.transferOut(epOut, bytes);
          if (result.status === 'stall') {
            warn('OUT 엔드포인트 stall — clearHalt');
            await device.clearHalt('out', epOut);
          }
        },
        close: () => {},
        abort: () => {},
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  ch340Serial — navigator.serial 호환 객체
  // ─────────────────────────────────────────────────────────────────
  const ch340Serial = {
    async requestPort() {
      // 필터:
      //   - WCH 벤더 전체(0x1a86): CH340/CH341/CH343/CH9102 등
      //   - USB 클래스 0x02(CDC-ACM): ESP32-S3 native, Arduino Leonardo 등 표준 CDC 장치
      //   → 아래 auto-detect가 CDC vs 벤더 자동 분기하므로 보드 교체에 강함.
      const device = await navigator.usb.requestDevice({
        filters: [
          { vendorId: CH340_VID },
          { classCode: 0x02 },
        ],
      });
      log(`선택된 장치: VID=0x${device.vendorId.toString(16)} PID=0x${device.productId.toString(16)} ` +
          `product="${device.productName || '?'}" manufacturer="${device.manufacturerName || '?'}"`);

      // === 프로토콜 자동 감지 ===
      // CH340/CH341: 인터페이스 0 클래스 = 0xFF (벤더). Ch340Port 사용.
      // CH343/CH9102: 인터페이스 0 클래스 = 0x02 (CDC Control), 인터페이스 1 = 0x0A (CDC Data).
      //                → web-serial-polyfill의 SerialPort로 위임.
      try {
        if (!device.opened) await device.open();
        if (device.configuration === null) await device.selectConfiguration(1);
        const iface0 = device.configuration.interfaces[0];
        const cls = iface0.alternate.interfaceClass;
        log(`interface 0 class = 0x${cls.toString(16).padStart(2,'0')} (0x02=CDC, 0xFF=벤더)`);
        if (cls === 0x02) {
          if (window.PolyfillSerialPort) {
            log('→ CDC-ACM 감지. web-serial-polyfill의 SerialPort로 위임');
            return new window.PolyfillSerialPort(device);
          } else {
            warn('CDC-ACM 장치인데 폴리필이 로드 안 됨 — Ch340Port로 시도(실패 예상)');
          }
        }
      } catch (e) {
        warn(`클래스 감지 실패, 벤더 프로토콜로 진행: ${e.message}`);
      }
      return new Ch340Port(device);
    },
    async getPorts() {
      const devices = await navigator.usb.getDevices();
      return devices
        .filter(d => d.vendorId === CH340_VID)
        .map(d => new Ch340Port(d));
    },
    // 이벤트 리스너 지원 (Web Serial과 유사 — 우리 앱은 사용 안 함)
    addEventListener() {},
    removeEventListener() {},
  };

  // 진단용: 아무 USB 장치나 요청 — Chrome이 보는 장치를 확인하는 목적.
  // 페이지 콘솔에서 window.ch340Diag.scanAny()로 호출 가능.
  global.ch340Diag = {
    async scanAny() {
      try {
        const device = await navigator.usb.requestDevice({ filters: [] });
        log('[진단] 선택된 장치:', {
          vendorId: '0x' + device.vendorId.toString(16),
          productId: '0x' + device.productId.toString(16),
          productName: device.productName,
          manufacturerName: device.manufacturerName,
          serialNumber: device.serialNumber,
          usbVersion: `${device.usbVersionMajor}.${device.usbVersionMinor}`,
        });
        return device;
      } catch (e) {
        warn('[진단] 실패:', e.message);
        return null;
      }
    },
    async listAuthorized() {
      const devices = await navigator.usb.getDevices();
      log(`[진단] 승인된 USB 장치 ${devices.length}개:`);
      devices.forEach((d, i) => log(`  [${i}] VID=0x${d.vendorId.toString(16)} PID=0x${d.productId.toString(16)} ${d.productName || ''}`));
      return devices;
    },
  };

  global.ch340Serial = ch340Serial;
  log('CH340 WebUSB 드라이버 로드 완료');
})(window);
