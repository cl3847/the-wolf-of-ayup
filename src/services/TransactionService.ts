import DAOs from "../models/DAOs";
import UserStock from "../models/user/UserStock";
import {Pool} from "pg";
import UserNotFoundError from "../models/error/UserNotFoundError";
import StockNotFoundError from "../models/error/StockNotFoundError";
import InsufficientBalanceError from "../models/error/InsufficientBalanceError";
import InsufficientStockQuantityError from "../models/error/InsufficientStockQuantityError";
import StockTransaction from "../models/transaction/StockTransaction";
import WireTransaction from "../models/transaction/WireTransaction";
import InsufficientItemQuantityError from "../models/error/InsufficientItemQuantityError";
import ItemNotFoundError from "../models/error/ItemNotFoundError";
import Request from "../models/request/Request";
import RequestNotFoundError from "../models/error/RequestNotFoundError";
import RequestTransaction from "../models/transaction/RequestTransaction";
import config from "../../config";
import InsufficentNetWorthError from "../models/error/InsufficientNetWorthError";
import Item from "../models/item/Item";
import {getLevel} from "../utils/GDUtils";

class TransactionService {
    private daos: DAOs;
    private pool: Pool;

    constructor(daos: DAOs, pool: Pool) {
        this.daos = daos;
        this.pool = pool;
    }

    public async replaceItemWithNew(uid: string, item1Id: string, item2Id: string): Promise<void> {
        const pc = await this.pool.connect();
        const userPortfolio = await this.daos.users.getUserPortfolio(pc, uid);
        if (!userPortfolio) {
            pc.release();
            throw new UserNotFoundError(uid);
        }
        const inventory = await this.daos.users.getInventory(pc, uid);
        const item1Holding = inventory.find(i => i.item_id === item1Id);
        if (!item1Holding) {
            pc.release();
            throw new InsufficientItemQuantityError(uid, 0, 1);
        }
        const item2 = await this.daos.items.getItem(pc, item2Id);
        if (!item2) {
            pc.release();
            throw new ItemNotFoundError(item2Id);
        }
        let item2Holding = await this.daos.users.getItemHolding(pc, uid, item2Id);
        if (!item2Holding) {
            item2Holding = {
                uid: uid,
                item_id: item2Id,
                quantity: 0,
            };
            await this.daos.users.createItemHolding(pc, item2Holding);
        }
        const newItem1Quantity = item1Holding.quantity - 1;
        const newItem2Quantity = item2Holding.quantity + 1;

        try {
            await pc.query('BEGIN');
            await this.daos.users.updateItemHolding(pc, uid, item1Holding.item_id, {quantity: newItem1Quantity});
            await this.daos.users.updateItemHolding(pc, uid, item2Holding.item_id, {quantity: newItem2Quantity});
            await pc.query('COMMIT');
            return;
        } catch (err) {
            await pc.query('ROLLBACK');
            throw err; // Re-throw to be handled by the caller
        } finally {
            pc.release();
        }
    }

    /**
     * Buys a stock for a user and updates their balance and stock holdings.
     * @param {string} uid The user ID
     * @param {string} ticker The stock ticker of the stock to buy
     * @param {number} add The quantity of the stock to buy
     * @param {boolean} useCredit Whether to use credit for the purchase
     * @returns {Promise<void>} A promise resolving to nothing
     */
    public async buyStock(uid: string, ticker: string, add: number, useCredit: boolean): Promise<StockTransaction> {
        const pc = await this.pool.connect();

        const user = await this.daos.users.getUserPortfolio(pc, uid);
        const stock = await this.daos.stocks.getStock(pc, ticker);

        if (!user) {
            pc.release();
            throw new UserNotFoundError(uid);
        } else if (!stock) {
            pc.release();
            throw new StockNotFoundError(ticker);
        }

        const cost = stock.price * add;
        const userAvailableCredit = Math.max(user.credit_limit - user.loan_balance, 0);
        let useCreditAmount = 0;
        if (user.balance < cost) {
            if (useCredit && user.balance + userAvailableCredit > stock.price * add) {
                // user has enough credit...
                useCreditAmount = stock.price * add - user.balance;
            } else {
                pc.release();
                throw new InsufficientBalanceError(uid, user.balance, cost);
            }
        }

        const holding = await this.daos.users.getMostRecentStockHolding(pc, uid, ticker);
        const newQuantity = holding ? holding.quantity + add : add;
        const newBalance = user.balance + useCreditAmount - cost;
        const newDebt = user.loan_balance + useCreditAmount;

        try {
            await pc.query('BEGIN');

            const newHolding: UserStock = {
                uid: uid,
                ticker: ticker,
                quantity: newQuantity,
                timestamp: Date.now(),
            };
            await this.daos.users.createStockHolding(pc, newHolding);
            await this.daos.users.updateUser(pc, uid, {balance: newBalance, loan_balance: newDebt});

            // save transaction record
            const transactionRecord: StockTransaction = {
                type: 'buy',
                uid: uid,
                ticker: ticker,
                balance_change: -(cost - useCreditAmount),
                credit_change: useCreditAmount,
                quantity: add,
                price: stock.price,
                total_price: cost,
                timestamp: Date.now(),
            };
            await this.daos.transactions.createTransaction(pc, transactionRecord);
            await pc.query('COMMIT');
            return transactionRecord;
        } catch (err) {
            await pc.query('ROLLBACK');
            throw err; // Re-throw to be handled by the caller
        } finally {
            pc.release();
        }
    }

    public async sellStock(uid: string, ticker: string, remove: number): Promise<StockTransaction> {
        const pc = await this.pool.connect();

        const user = await this.daos.users.getUserPortfolio(pc, uid);
        const stock = await this.daos.stocks.getStock(pc, ticker);
        const holding = await this.daos.users.getMostRecentStockHolding(pc, uid, ticker);

        if (!user) {
            pc.release();
            throw new UserNotFoundError(uid);
        } else if (!stock) {
            pc.release();
            throw new StockNotFoundError(ticker);
        }

        if (!holding || remove > holding.quantity) {
            pc.release();
            throw new InsufficientStockQuantityError(uid, holding?.quantity || 0, remove);
        }

        const newQuantity = holding.quantity - remove;
        const newBalance = user.balance + stock.price * remove;

        try {
            await pc.query('BEGIN');
            const newHolding: UserStock = {
                uid: uid,
                ticker: ticker,
                quantity: newQuantity,
                timestamp: Date.now(),
            };
            await this.daos.users.createStockHolding(pc, newHolding);
            await this.daos.users.updateUser(pc, uid, {balance: newBalance});

            // save transaction record
            const transactionRecord: StockTransaction = {
                type: 'sell',
                uid: uid,
                ticker: ticker,
                quantity: remove,
                balance_change: stock.price * remove,
                credit_change: 0,
                price: stock.price,
                total_price: stock.price * remove,
                timestamp: Date.now(),
            };
            await this.daos.transactions.createTransaction(pc, transactionRecord);
            await pc.query('COMMIT');
            return transactionRecord;
        } catch (err) {
            await pc.query('ROLLBACK');
            throw err; // Re-throw to be handled by the caller
        } finally {
            pc.release();
        }
    }

    public async wireToUser(fromUid: string, destUid: string, amount: number, memo: string | null): Promise<WireTransaction> {
        const pc = await this.pool.connect();
        const fromUser = await this.daos.users.getUserPortfolio(pc, fromUid);
        if (!fromUser) {
            pc.release();
            throw new UserNotFoundError(fromUid);
        }
        const destUser = await this.daos.users.getUser(pc, destUid);
        if (!destUser) {
            pc.release();
            throw new UserNotFoundError(destUid);
        }
        if (fromUser.balance < amount) {
            pc.release();
            throw new InsufficientBalanceError(fromUid, fromUser.balance, amount);
        }
        if (fromUser.netWorth() - amount < config.game.minHeldWire) {
            pc.release();
            throw new InsufficentNetWorthError(fromUid, fromUser.netWorth(), amount);
        }

        try {
            await pc.query('BEGIN');
            await this.daos.users.updateUser(pc, fromUid, {balance: fromUser.balance - amount});
            await this.daos.users.updateUser(pc, destUid, {balance: destUser.balance + amount});
            const transactionRecord: WireTransaction = {
                type: 'wire',
                uid: fromUid,
                balance_change: -amount,
                destination: destUid,
                is_destination_user: true,
                timestamp: Date.now(),
                memo: memo,
            };
            await this.daos.transactions.createTransaction(pc, transactionRecord);
            await pc.query('COMMIT');
            return transactionRecord;
        } catch (err) {
            await pc.query('ROLLBACK');
            throw err;
        } finally {
            pc.release();
        }
    }

    public async wireToEntity(fromUid: string, destIdentifier: string, amount: number, memo: string | null): Promise<WireTransaction> {
        const pc = await this.pool.connect();
        const fromUser = await this.daos.users.getUserPortfolio(pc, fromUid);
        if (!fromUser) {
            pc.release();
            throw new UserNotFoundError(fromUid);
        }
        if (fromUser.balance < amount) {
            pc.release();
            throw new InsufficientBalanceError(fromUid, fromUser.balance, amount);
        }

        try {
            await pc.query('BEGIN');
            await this.daos.users.updateUser(pc, fromUid, {balance: fromUser.balance - amount});
            const transactionRecord: WireTransaction = {
                type: 'wire',
                uid: fromUid,
                balance_change: -amount,
                destination: destIdentifier,
                is_destination_user: false,
                timestamp: Date.now(),
                memo: memo,
            };
            await this.daos.transactions.createTransaction(pc, transactionRecord);
            await pc.query('COMMIT');
            return transactionRecord;
        } catch (err) {
            await pc.query('ROLLBACK');
            throw err;
        } finally {
            pc.release();
        }
    }

    public async cashItem(uid: string, itemId: string, itemValue: number): Promise<void> {
        const pc = await this.pool.connect();
        const userPortfolio = await this.daos.users.getUserPortfolio(pc, uid);
        if (!userPortfolio) {
            pc.release();
            throw new UserNotFoundError(uid);
        }
        const inventory = await this.daos.users.getInventory(pc, uid);
        const itemHolding = inventory.find(i => i.item_id === itemId);
        if (!itemHolding) {
            pc.release();
            throw new InsufficientItemQuantityError(uid, 0, 1);
        }
        const newItemQuantity = itemHolding.quantity - 1;
        const newUserBalance = userPortfolio.balance + itemValue;

        try {
            await pc.query('BEGIN');
            await this.daos.users.updateItemHolding(pc, uid, itemHolding.item_id, {quantity: newItemQuantity});
            await this.daos.users.updateUser(pc, uid, {balance: newUserBalance});
            await pc.query('COMMIT');
            return;
        } catch (err) {
            await pc.query('ROLLBACK');
            throw err; // Re-throw to be handled by the caller
        } finally {
            pc.release();
        }
    }

    public async contributeBounty(uid: string, levelId: string, amount: number): Promise<RequestTransaction> {
        const pc = await this.pool.connect();
        const user = await this.daos.users.getUserPortfolio(pc, uid);
        if (!user) {
            pc.release();
            throw new UserNotFoundError(uid);
        }
        if (user.balance < amount) {
            pc.release();
            throw new InsufficientBalanceError(uid, user.balance, amount);
        }
        if (user.netWorth() - amount < config.game.minHeldWire) {
            pc.release();
            throw new InsufficentNetWorthError(uid, user.netWorth(), amount);
        }
        const inventory = await this.daos.users.getInventory(pc, uid);
        const currentCard = inventory.find((x: Item) => x.type === "credit_card");

        try {
            await pc.query('BEGIN');

            let cashbackAmount = 0;
            if (currentCard) {
                let cashback = 0;
                switch (currentCard.item_id) {
                    case '010': // green
                        cashback = 0.01;
                        break;
                    case '020': // gold
                        cashback = 0.02;
                        break;
                    case '030': // rose gold
                        cashback = 0.03;
                        break;
                    case '040': // white gold
                        cashback = 0.04;
                        break;
                    case '050': // platinum
                        cashback = 0.05;
                        break;
                    case '060': // centurion
                        cashback = 0.1;
                        break;
                    default:
                        cashback = 0;
                }
                cashbackAmount = Math.floor(amount * cashback);
            }

            await this.daos.users.updateUser(pc, uid, {balance: (user.balance - amount) + cashbackAmount});
            let levelReq = await this.daos.requests.getRequest(pc, levelId);
            if (!levelReq) {
                const level = await getLevel(levelId);
                levelReq = {
                    level_id: levelId,
                    bounty: 0,
                    name: level?.name,
                    creator: level?.creator,
                    requester_uid: uid
                };
                await this.daos.requests.createRequest(pc, levelReq);
            }
            levelReq.bounty += amount;
            await this.daos.requests.updateRequest(pc, levelId, levelReq);

            const transactionRecord: RequestTransaction = {
                destination: levelId,
                uid: uid,
                type: 'request_add',
                balance_change: -amount + cashbackAmount,
                price: amount,
                timestamp: Date.now()
            };
            await this.daos.transactions.createTransaction(pc, transactionRecord);

            await pc.query('COMMIT');
            return transactionRecord;
        } catch (err) {
            await pc.query('ROLLBACK');
            throw err;
        } finally {
            pc.release();
        }
    }

    public async viewRequestPool(limit: number): Promise<Request[]> {
        const pc = await this.pool.connect();
        try {
            return this.daos.requests.getAllRequests(pc, limit);
        } finally {
            pc.release();
        }
    }

    public async getRequest(levelId: string): Promise<Request | null> {
        const pc = await this.pool.connect();
        try {
            return this.daos.requests.getRequest(pc, levelId);
        } finally {
            pc.release();
        }
    }

    public async acceptBounty(uid: string, levelId: string): Promise<RequestTransaction> {
        const pc = await this.pool.connect();
        const user = await this.daos.users.getUser(pc, uid);
        if (!user) {
            pc.release();
            throw new UserNotFoundError(uid);
        }
        const request = await this.daos.requests.getRequest(pc, levelId);
        if (!request || request.bounty === 0) {
            pc.release();
            throw new RequestNotFoundError(levelId);
        }
        const commissionAmount = Math.ceil(request.bounty * config.game.modCommission);

        const newBalance = user.balance + commissionAmount;
        try {
            await pc.query('BEGIN');
            await this.daos.users.updateUser(pc, uid, {balance: newBalance});
            request.bounty = 0;
            await this.daos.requests.updateRequest(pc, levelId, request);

            const transactionRecord: RequestTransaction = {
                destination: levelId,
                uid: uid,
                type: 'request_add',
                price: request.bounty,
                balance_change: commissionAmount,
                timestamp: Date.now()
            };
            await this.daos.transactions.createTransaction(pc, transactionRecord);
            await pc.query('COMMIT');
            return transactionRecord;
        } catch (err) {
            await pc.query('ROLLBACK');
            throw err;
        } finally {
            pc.release();
        }
    }

    public async updateRequest(levelId: string, request: Partial<Request>): Promise<void> {
        const pc = await this.pool.connect();
        try {
            await this.daos.requests.updateRequest(pc, levelId, request);
        } finally {
            pc.release();
        }
    }
}

export default TransactionService;
