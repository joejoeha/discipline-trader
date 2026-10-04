import { create } from "zustand";
import { createGateway } from "./gateway/DemoGateway";
import type { BootstrapState, ExchangeId, MarketSnapshot, OrderIntent, OrderResult, OrderReview, Position, Timeframe, TradingMode, TradingPlan } from "./types";

export const gateway = createGateway();
let marketRequestSequence = 0;

interface TradingStore {
  boot: BootstrapState | null;
  market: MarketSnapshot | null;
  exchange: ExchangeId;
  symbol: string;
  timeframe: Timeframe;
  mode: TradingMode;
  loading: boolean;
  error: string | null;
  notice: string | null;
  draftOrderPrice: { value: string; nonce: number } | null;
  closePositionRequest: { position: Position; nonce: number } | null;
  initialize: () => Promise<void>;
  selectMarket: (exchange: ExchangeId, symbol: string) => Promise<void>;
  setTimeframe: (timeframe: Timeframe) => Promise<void>;
  setMode: (mode: TradingMode) => Promise<void>;
  setMarket: (market: MarketSnapshot) => void;
  setDraftOrderPrice: (value: string) => void;
  prepareClosePosition: (position: Position) => Promise<void>;
  savePlan: (plan: TradingPlan) => Promise<TradingPlan>;
  armPlan: (id: string) => Promise<TradingPlan>;
  triggerPlan: (id: string) => Promise<TradingPlan>;
  prepareOrder: (intent: OrderIntent) => Promise<OrderReview>;
  submitOrder: (token: string, acceptWarnings: boolean) => Promise<OrderResult>;
  syncAccount: () => Promise<void>;
  refresh: () => Promise<void>;
  clearMessage: () => void;
}

export const useTradingStore = create<TradingStore>((set, get) => ({
  boot: null, market: null, exchange: "ourbit", symbol: "BTC_USDT", timeframe: "15m", mode: "paper", loading: true, error: null, notice: null, draftOrderPrice: null, closePositionRequest: null,
  initialize: async () => {
    const request = ++marketRequestSequence;
    set({ loading: true, error: null });
    try {
      const boot = await gateway.bootstrap();
      const market = await gateway.getMarket(boot.selectedExchange, boot.selectedSymbol, "15m");
      if (request === marketRequestSequence) set({ boot, market, exchange: boot.selectedExchange, symbol: boot.selectedSymbol, mode: boot.mode, loading: false });
    } catch (error) { if (request === marketRequestSequence) set({ error: message(error), loading: false }); }
  },
  selectMarket: async (exchange, symbol) => {
    const request = ++marketRequestSequence;
    const capability = get().boot?.capabilities.find((item) => item.exchange === exchange);
    const forcePaper = get().mode === "live" && !capability?.liveTrading;
    set({ exchange, symbol, loading: true, error: null, ...(forcePaper ? { mode: "paper" as const, notice: "目标交易所当前不具备实盘能力，已切回模拟盘" } : {}) });
    const timeframe = get().timeframe;
    try {
      const market = await gateway.getMarket(exchange, symbol, timeframe);
      if (request === marketRequestSequence) set({ market, loading: false });
    } catch (error) { if (request === marketRequestSequence) set({ error: message(error), loading: false }); }
  },
  setTimeframe: async (timeframe) => {
    const request = ++marketRequestSequence;
    const { exchange, symbol } = get(); set({ timeframe, loading: true });
    try {
      const market = await gateway.getMarket(exchange, symbol, timeframe);
      if (request === marketRequestSequence) set({ market, loading: false });
    } catch (error) { if (request === marketRequestSequence) set({ error: message(error), loading: false }); }
  },
  setMode: async (mode) => {
    if (mode === "live") {
      const { boot, exchange, market } = get();
      const capability = boot?.capabilities.find((item) => item.exchange === exchange);
      const credential = boot?.credentials.find((item) => item.exchange === exchange);
      const reasons = [
        !boot?.riskSettings ? "尚未保存全局风险参数" : null,
        boot?.liveLock.emergencyStopped ? "立即停止实盘开关仍处于触发状态" : null,
        boot?.liveLock.locked ? "需要在设置页用本机 PIN 解锁" : null,
        !credential?.verified || !credential.permissions.includes("trade") ? "API Key 的读取与交易权限尚未验证" : null,
        !capability?.liveTrading ? capability?.reason ?? "交易所实盘能力探测未通过" : null,
        !market?.connected || market.source !== "exchange" ? "真实行情尚未连接" : null,
      ].filter((value): value is string => Boolean(value));
      if (reasons.length) { set({ error: `无法进入实盘：${reasons.join("；")}` }); return; }
      try {
        const account = await gateway.syncLiveAccount(exchange);
        set({
          mode,
          boot: boot ? { ...boot, balances: account.balances, positions: account.positions, orders: account.orders } : boot,
          notice: "真实账户已同步；已进入实盘模式，每笔订单仍需最终确认"
        });
      } catch (error) {
        set({ error: `真实账户同步失败，未进入实盘：${message(error)}` });
      }
      return;
    }
    set({ mode, notice: "已切换到模拟盘" });
  },
  setMarket: (market) => set((state) => market.instrument.exchange === state.exchange && market.instrument.symbol === state.symbol ? { market, loading: false } : {}),
  setDraftOrderPrice: (value) => set({ draftOrderPrice: { value, nonce: Date.now() } }),
  prepareClosePosition: async (position) => {
    set({ closePositionRequest: { position, nonce: Date.now() }, notice: `已带入 ${position.symbol} 平仓面板` });
    if (get().exchange !== position.exchange || get().symbol !== position.symbol) await get().selectMarket(position.exchange, position.symbol);
  },
  savePlan: async (plan) => {
    try { const saved = await gateway.savePlan(plan); await get().refresh(); set({ notice: "交易计划已保存" }); return saved; }
    catch (error) { set({ error: message(error) }); throw error; }
  },
  armPlan: async (id) => {
    try { const plan = await gateway.armPlan(id); await get().refresh(); set({ notice: "计划已启用，等待触发条件" }); return plan; }
    catch (error) { set({ error: message(error) }); throw error; }
  },
  triggerPlan: async (id) => {
    try { const plan = await gateway.triggerPlan(id); await get().refresh(); set({ notice: `计划已触发，冷静期 ${plan.cooldownMinutes} 分钟` }); return plan; }
    catch (error) { set({ error: message(error) }); throw error; }
  },
  prepareOrder: async (intent) => {
    try { return await gateway.prepareOrder(intent); }
    catch (error) { set({ error: message(error) }); throw error; }
  },
  submitOrder: async (token, acceptWarnings) => {
    try { const result = await gateway.submitOrder(token, acceptWarnings); await get().refresh(); set({ notice: result.message }); return result; }
    catch (error) { set({ error: message(error) }); throw error; }
  },
  syncAccount: async () => {
    if (get().mode !== "live") return;
    try {
      const account = await gateway.syncLiveAccount(get().exchange);
      const boot = get().boot;
      if (boot) set({ boot: { ...boot, balances: account.balances, positions: account.positions, orders: account.orders } });
    } catch (error) {
      const boot = get().boot;
      if (!boot?.liveLock.locked) await gateway.lockLive("账户状态与本地状态不同步").catch(() => undefined);
      set({
        boot: boot ? { ...boot, liveLock: { ...boot.liveLock, locked: true, reasons: [...new Set([...boot.liveLock.reasons, "账户状态与本地状态不同步"])] } } : boot,
        error: `真实账户状态不同步，已锁定新增风险；撤单、只减仓和平仓仍可尝试：${message(error)}`
      });
    }
  },
  refresh: async () => {
    let boot = await gateway.bootstrap();
    const capability = boot.capabilities.find((item) => item.exchange === get().exchange);
    const forcePaper = get().mode === "live" && !capability?.liveTrading;
    if (get().mode === "live" && !forcePaper) {
      try {
        const account = await gateway.syncLiveAccount(get().exchange);
        boot = { ...boot, balances: account.balances, positions: account.positions, orders: account.orders };
      } catch (error) {
        set({ mode: "paper", error: `真实账户同步失败，已退出实盘：${message(error)}` });
      }
    }
    set({ boot, ...(forcePaper ? { mode: "paper" as const, notice: "实盘保护状态发生变化，已自动切回模拟盘" } : {}) });
  },
  clearMessage: () => set({ error: null, notice: null })
}));

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
