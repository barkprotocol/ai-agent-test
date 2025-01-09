import {
    ProcessedTokenData,
    TokenSecurityData,
} from "../types/token.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { TokenProvider } from "./token.js";
import { WalletProvider } from "./wallet.js";
import { SimulationSellingService } from "./simulationSellingService.js";
import { TrustScoreDatabase } from "@elizaos/plugin-trustdb";
import { settings } from "@elizaos/core";
import { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { getAssociatedTokenAddress } from "../../src/utils/spl-token/accounts";



interface IRecommenderMetrics {
    recommenderId: string;
    trustScore: number;
    totalRecommendations: number;
    successfulRecs: number;
    avgTokenPerformance: number;
    riskScore: number;
    consistencyScore: number;
    virtualConfidence: number;
    lastActiveDate: Date;
    trustDecay: number;
    lastUpdated: Date;
}

interface ITokenPerformance {
    tokenAddress: string;
    symbol: string;
    priceChange24h: number;
    volumeChange24h: number;
    trade_24h_change: number;
    liquidity: number;
    liquidityChange24h: number;
    holderChange24h: number;
    rugPull: boolean;
    isScam: boolean;
    marketCapChange24h: number;
    sustainedGrowth: boolean;
    rapidDump: boolean;
    suspiciousVolume: boolean;
    validationTrust: number;
    balance: number;
    initialMarketCap: number;
    lastUpdated: Date;
}

interface ITradePerformance {
    token_address: string;
    recommender_id: string;
    buy_price: number;
    sell_price: number;
    buy_timeStamp: string;
    sell_timeStamp: string;
    buy_amount: number;
    sell_amount: number;
    buy_sol: number;
    received_sol: number;
    buy_value_usd: number;
    sell_value_usd: number;
    profit_usd: number;
    profit_percent: number;
    buy_market_cap: number;
    sell_market_cap: number;
    market_cap_change: number;
    buy_liquidity: number;
    sell_liquidity: number;
    liquidity_change: number;
    last_updated: string;
    rapidDump: boolean;
}

interface ITokenRecommendation {
    id: string;
    recommenderId: string;
    tokenAddress: string;
    timestamp: Date;
    initialMarketCap: number;
    initialLiquidity: number;
    initialPrice: number;
}

interface ITrustScoreDatabase {
    getRecommenderMetrics(recommenderId: string): Promise<IRecommenderMetrics>;
    updateRecommenderMetrics(metrics: IRecommenderMetrics): Promise<void>;
    getOrCreateRecommenderWithTelegramId(telegramId: string): Promise<any>;
    addTradePerformance(data: ITradePerformance, isSimulation: boolean): Promise<void>;
    addTokenRecommendation(recommendation: ITokenRecommendation): Promise<void>;
    upsertTokenPerformance(performance: ITokenPerformance): Promise<void>;
    updateTokenBalance(tokenAddress: string, balance: number): Promise<void>;
    getTokenBalance(tokenAddress: string): number;
    addTransaction(transaction: any): Promise<void>;
    getLatestTradePerformance(tokenAddress: string, recommenderId: string, isSimulation: boolean): Promise<ITradePerformance>;
    updateTradePerformanceOnSell(tokenAddress: string, recommenderId: string, buyTimeStamp: string, sellDetails: any, isSimulation: boolean): Promise<void>;
    getTokenPerformance(tokenAddress: string): ITokenPerformance;
    calculateValidationTrust(tokenAddress: string): number;
    getRecommendationsByDateRange(startDate: Date, endDate: Date): ITokenRecommendation[];
}

const Wallet = settings.MAIN_WALLET_ADDRESS;
interface TradeData {
    buy_amount: number;
    is_simulation: boolean;
}
interface sellDetails {
    sell_amount: number;
    sell_recommender_id: string | null;
}
interface _RecommendationGroup {
    recommendation: any;
    trustScore: number;
}

interface RecommenderData {
    recommenderId: string;
    trustScore: number;
    riskScore: number;
    consistencyScore: number;
    recommenderMetrics: IRecommenderMetrics; // Updated type
}

interface TokenRecommendationSummary {
    tokenAddress: string;
    averageTrustScore: number;
    averageRiskScore: number;
    averageConsistencyScore: number;
    recommenders: RecommenderData[];
}
export class TrustScoreManager {
    private tokenProvider: TokenProvider;
    private trustScoreDb: ITrustScoreDatabase; // Updated type
    private simulationSellingService: SimulationSellingService;
    private connection: Connection;
    private baseMint: PublicKey;
    private DECAY_RATE = 0.95;
    private MAX_DECAY_DAYS = 30;
    private backend;
    private backendToken;
    constructor(
        runtime: IAgentRuntime,
        tokenProvider: TokenProvider,
        trustScoreDb: ITrustScoreDatabase  // Updated type
    ) {
        this.tokenProvider = tokenProvider;
        this.trustScoreDb = trustScoreDb;
        const rpcUrl = runtime.getSetting("RPC_URL");
        if (!rpcUrl) {
            throw new Error("RPC_URL setting is required");
        }
        this.connection = new Connection(rpcUrl);
        this.baseMint = new PublicKey(
            runtime.getSetting("BASE_MINT") ||
                "So11111111111111111111111111111111111111112"
        );
        this.backend = runtime.getSetting("BACKEND_URL");
        this.backendToken = runtime.getSetting("BACKEND_TOKEN");
        this.simulationSellingService = new SimulationSellingService(
            runtime,
            this.trustScoreDb
        );
    }

    //getRecommenederBalance
    async getRecommenederBalance(recommenderWallet: string): Promise<number> {
        try {
            const tokenAta = await getAssociatedTokenAddress(
                new PublicKey(recommenderWallet),
                this.baseMint
            );
            const tokenBalInfo =
                await this.connection.getTokenAccountBalance(tokenAta);
            const tokenBalance = tokenBalInfo.value.amount;
            const balance = parseFloat(tokenBalance);
            return balance;
        } catch (error) {
            console.error("Error fetching balance", error);
            return 0;
        }
    }

    /**
     * Generates and saves trust score based on processed token data and user recommendations.
     * @param tokenAddress The address of the token to analyze.
     * @param recommenderId The UUID of the recommender.
     * @returns An object containing TokenPerformance and RecommenderMetrics.
     */
    async generateTrustScore(
        tokenAddress: string,
        recommenderId: string,
        recommenderWallet: string
    ): Promise<{
        tokenPerformance: any;
        recommenderMetrics: any;
    }> {
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        console.log(`Fetched processed token data for token: ${tokenAddress}`);

        const recommenderMetrics =
            await this.trustScoreDb.getRecommenderMetrics(recommenderId);

        const isRapidDump = await this.isRapidDump(tokenAddress);
        const sustainedGrowth = await this.sustainedGrowth(tokenAddress);
        const suspiciousVolume = await this.suspiciousVolume(tokenAddress);
        const balance = await this.getRecommenederBalance(recommenderWallet);
        const virtualConfidence = balance / 1000000; // TODO: create formula to calculate virtual confidence based on user balance
        const lastActive = recommenderMetrics.lastActiveDate;
        const now = new Date();
        const inactiveDays = Math.floor(
            (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24)
        );
        const decayFactor = Math.pow(
            this.DECAY_RATE,
            Math.min(inactiveDays, this.MAX_DECAY_DAYS)
        );
        const decayedScore = recommenderMetrics.trustScore * decayFactor;
        const validationTrustScore =
            this.trustScoreDb.calculateValidationTrust(tokenAddress);

        return {
            tokenPerformance: {
                tokenAddress:
                    processedData.dexScreenerData.pairs[0]?.baseToken.address ||
                    "",
                priceChange24h:
                    processedData.tradeData.price_change_24h_percent,
                volumeChange24h: processedData.tradeData.volume_24h,
                trade_24h_change:
                    processedData.tradeData.trade_24h_change_percent,
                liquidity:
                    processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0,
                liquidityChange24h: 0,
                holderChange24h:
                    processedData.tradeData.unique_wallet_24h_change_percent,
                rugPull: false,
                isScam: processedData.tokenCodex.isScam,
                marketCapChange24h: 0,
                sustainedGrowth: sustainedGrowth,
                rapidDump: isRapidDump,
                suspiciousVolume: suspiciousVolume,
                validationTrust: validationTrustScore,
                balance: balance,
                initialMarketCap:
                    processedData.dexScreenerData.pairs[0]?.marketCap || 0,
                lastUpdated: new Date(),
                symbol: "",
            },
            recommenderMetrics: {
                recommenderId: recommenderId,
                trustScore: recommenderMetrics.trustScore,
                totalRecommendations: recommenderMetrics.totalRecommendations,
                successfulRecs: recommenderMetrics.successfulRecs,
                avgTokenPerformance: recommenderMetrics.avgTokenPerformance,
                riskScore: recommenderMetrics.riskScore,
                consistencyScore: recommenderMetrics.consistencyScore,
                virtualConfidence: virtualConfidence,
                lastActiveDate: now,
                trustDecay: decayedScore,
                lastUpdated: new Date(),
            },
        };
    }

    async updateRecommenderMetrics(
        recommenderId: string,
        tokenPerformance: ITokenPerformance, // Updated type
        recommenderWallet: string
    ): Promise<void> {
        const recommenderMetrics =
            await this.trustScoreDb.getRecommenderMetrics(recommenderId);

        const totalRecommendations =
            recommenderMetrics.totalRecommendations + 1;
        const successfulRecs = tokenPerformance.rugPull
            ? recommenderMetrics.successfulRecs
            : recommenderMetrics.successfulRecs + 1;
        const avgTokenPerformance =
            (recommenderMetrics.avgTokenPerformance *
                recommenderMetrics.totalRecommendations +
                tokenPerformance.priceChange24h) /
            totalRecommendations;

        const overallTrustScore = this.calculateTrustScore(
            tokenPerformance,
            recommenderMetrics
        );
        const riskScore = this.calculateOverallRiskScore(
            tokenPerformance,
            recommenderMetrics
        );
        const consistencyScore = this.calculateConsistencyScore(
            tokenPerformance,
            recommenderMetrics
        );

        const balance = await this.getRecommenederBalance(recommenderWallet);
        const virtualConfidence = balance / 1000000; // TODO: create formula to calculate virtual confidence based on user balance
        const lastActive = recommenderMetrics.lastActiveDate;
        const now = new Date();
        const inactiveDays = Math.floor(
            (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24)
        );
        const decayFactor = Math.pow(
            this.DECAY_RATE,
            Math.min(inactiveDays, this.MAX_DECAY_DAYS)
        );
        const decayedScore = recommenderMetrics.trustScore * decayFactor;

        const newRecommenderMetrics: any = {
            recommenderId: recommenderId,
            trustScore: overallTrustScore,
            totalRecommendations: totalRecommendations,
            successfulRecs: successfulRecs,
            avgTokenPerformance: avgTokenPerformance,
            riskScore: riskScore,
            consistencyScore: consistencyScore,
            virtualConfidence: virtualConfidence,
            lastActiveDate: new Date(),
            trustDecay: decayedScore,
            lastUpdated: new Date(),
        };

        await this.trustScoreDb.updateRecommenderMetrics(newRecommenderMetrics);
    }

    calculateTrustScore(
        tokenPerformance: any,
        recommenderMetrics: any
    ): number {
        const riskScore = this.calculateRiskScore(tokenPerformance);
        const consistencyScore = this.calculateConsistencyScore(
            tokenPerformance,
            recommenderMetrics
        );

        return (riskScore + consistencyScore) / 2;
    }

    calculateOverallRiskScore(
        tokenPerformance: any,
        recommenderMetrics: any
    ) {
        const riskScore = this.calculateRiskScore(tokenPerformance);
        const consistencyScore = this.calculateConsistencyScore(
            tokenPerformance,
            recommenderMetrics
        );

        return (riskScore + consistencyScore) / 2;
    }

    calculateRiskScore(tokenPerformance: any): number {
        let riskScore = 0;
        if (tokenPerformance.rugPull) {
            riskScore += 10;
        }
        if (tokenPerformance.isScam) {
            riskScore += 10;
        }
        if (tokenPerformance.rapidDump) {
            riskScore += 5;
        }
        if (tokenPerformance.suspiciousVolume) {
            riskScore += 5;
        }
        return riskScore;
    }

    calculateConsistencyScore(
        tokenPerformance: any,
        recommenderMetrics: any
    ): number {
        const avgTokenPerformance = recommenderMetrics.avgTokenPerformance;
        const priceChange24h = tokenPerformance.priceChange24h;

        return Math.abs(priceChange24h - avgTokenPerformance);
    }

    async suspiciousVolume(tokenAddress: string): Promise<boolean> {
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        const unique_wallet_24h = processedData.tradeData.unique_wallet_24h;
        const volume_24h = processedData.tradeData.volume_24h;
        const suspiciousVolume = unique_wallet_24h / volume_24h > 0.5;
        console.log(`Fetched processed token data for token: ${tokenAddress}`);
        return suspiciousVolume;
    }

    async sustainedGrowth(tokenAddress: string): Promise<boolean> {
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        console.log(`Fetched processed token data for token: ${tokenAddress}`);

        return (processedData.tradeData.volume_24h_change_percent ?? 0) > 50;
    }

    async isRapidDump(tokenAddress: string): Promise<boolean> {
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        console.log(`Fetched processed token data for token: ${tokenAddress}`);

        return (processedData.tradeData.trade_24h_change_percent ?? 0) < -50;
    }

    async checkTrustScore(tokenAddress: string): Promise<TokenSecurityData> {
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        console.log(`Fetched processed token data for token: ${tokenAddress}`);

        return {
            ownerBalance: processedData.security.ownerBalance,
            creatorBalance: processedData.security.creatorBalance,
            ownerPercentage: processedData.security.ownerPercentage,
            creatorPercentage: processedData.security.creatorPercentage,
            top10HolderBalance: processedData.security.top10HolderBalance,
            top10HolderPercent: processedData.security.top10HolderPercent,
        };
    }

    /**
     * Creates a TradePerformance object based on token data and recommender.
     * @param tokenAddress The address of the token.
     * @param recommenderId The UUID of the recommender.
     * @param data ProcessedTokenData.
     * @returns TradePerformance object.
     */
    async createTradePerformance(
        runtime: IAgentRuntime,
        tokenAddress: string,
        recommenderId: string,
        data: TradeData
    ): Promise<ITradePerformance> { // Updated type
        const recommender =
            await this.trustScoreDb.getOrCreateRecommenderWithTelegramId(
                recommenderId
            );
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        const wallet = new WalletProvider(
            this.connection,
            new PublicKey(Wallet!)
        );

        let tokensBalance = 0;
        const prices = await wallet.fetchPrices(runtime);
        const solPrice = prices.solana.usd;
        const buySol = data.buy_amount / parseFloat(solPrice);
        const buy_value_usd = data.buy_amount * processedData.tradeData.price;
        const token = await this.tokenProvider.fetchTokenTradeData();
        const tokenCodex = await this.tokenProvider.fetchTokenCodex();
        const tokenPrice = token.price;
        tokensBalance = buy_value_usd / tokenPrice;

        const creationData = {
            token_address: tokenAddress,
            recommender_id: recommender.id,
            buy_price: processedData.tradeData.price,
            sell_price: 0,
            buy_timeStamp: new Date().toISOString(),
            sell_timeStamp: "",
            buy_amount: data.buy_amount,
            sell_amount: 0,
            buy_sol: buySol,
            received_sol: 0,
            buy_value_usd: buy_value_usd,
            sell_value_usd: 0,
            profit_usd: 0,
            profit_percent: 0,
            buy_market_cap:
                processedData.dexScreenerData.pairs[0]?.marketCap || 0,
            sell_market_cap: 0,
            market_cap_change: 0,
            buy_liquidity:
                processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0,
            sell_liquidity: 0,
            liquidity_change: 0,
            last_updated: new Date().toISOString(),
            rapidDump: false,
        };
        this.trustScoreDb.addTradePerformance(creationData, data.is_simulation);
        // generate unique uuid for each TokenRecommendation
        const tokenUUId = uuidv4();
        const tokenRecommendation: any = {
            id: tokenUUId,
            recommenderId: recommenderId,
            tokenAddress: tokenAddress,
            timestamp: new Date(),
            initialMarketCap:
                processedData.dexScreenerData.pairs[0]?.marketCap || 0,
            initialLiquidity:
                processedData.dexScreenerData.pairs[0]?.liquidity?.usd || 0,
            initialPrice: processedData.tradeData.price,
        };
        this.trustScoreDb.addTokenRecommendation(tokenRecommendation);

        this.trustScoreDb.upsertTokenPerformance({
            tokenAddress: tokenAddress,
            symbol: processedData.tokenCodex.symbol,
            priceChange24h: processedData.tradeData.price_change_24h_percent,
            volumeChange24h: processedData.tradeData.volume_24h,
            trade_24h_change: processedData.tradeData.trade_24h_change_percent ?? 0,
            liquidity:
                processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0,
            liquidityChange24h: 0,
            holderChange24h: processedData.tradeData.unique_wallet_24h_change_percent ?? 0,
            rugPull: false,
            isScam: tokenCodex.isScam,
            marketCapChange24h: 0,
            sustainedGrowth: false,
            rapidDump: false,
            suspiciousVolume: false,
            validationTrust: 0,
            balance: tokensBalance,
            initialMarketCap:
                processedData.dexScreenerData.pairs[0]?.marketCap || 0,
            lastUpdated: new Date(),
        });

        if (data.is_simulation) {
            // If the trade is a simulation update the balance
            this.trustScoreDb.updateTokenBalance(tokenAddress, tokensBalance);
            // generate some random hash for simulations
            const hash = Math.random().toString(36).substring(7);
            const transaction = {
                tokenAddress: tokenAddress,
                type: "buy" as "buy" | "sell",
                transactionHash: hash,
                amount: data.buy_amount,
                price: processedData.tradeData.price,
                isSimulation: true,
                timestamp: new Date().toISOString(),
            };
            this.trustScoreDb.addTransaction(transaction);
        }
        this.simulationSellingService.processTokenPerformance(
            tokenAddress,
            recommenderId
        );
        // api call to update trade performance
        this.createTradeInBe(tokenAddress, recommenderId, data);
        return creationData;
    }

    async delay(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async createTradeInBe(
        tokenAddress: string,
        recommenderId: string,
        data: TradeData,
        retries = 3,
        delayMs = 2000
    ) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await fetch(
                    `${this.backend}/api/updaters/createTradePerformance`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${this.backendToken}`,
                        },
                        body: JSON.stringify({
                            tokenAddress: tokenAddress,
                            tradeData: data,
                            recommenderId: recommenderId,
                        }),
                    }
                );
                // If the request is successful, exit the loop
                return;
            } catch (error) {
                console.error(
                    `Attempt ${attempt} failed: Error creating trade in backend`,
                    error
                );
                if (attempt < retries) {
                    console.log(`Retrying in ${delayMs} ms...`);
                    await this.delay(delayMs); // Wait for the specified delay before retrying
                } else {
                    console.error("All attempts failed.");
                }
            }
        }
    }

    /**
     * Updates a trade with sell details.
     * @param tokenAddress The address of the token.
     * @param recommenderId The UUID of the recommender.
     * @param buyTimeStamp The timestamp when the buy occurred.
     * @param sellDetails An object containing sell-related details.
     * @param isSimulation Whether the trade is a simulation. If true, updates in simulation_trade; otherwise, in trade.
     * @returns boolean indicating success.
     */

    async updateSellDetails(
        runtime: IAgentRuntime,
        tokenAddress: string,
        recommenderId: string,
        sellTimeStamp: string,
        sellDetails: sellDetails,
        isSimulation: boolean
    ) {
        const recommender =
            await this.trustScoreDb.getOrCreateRecommenderWithTelegramId(
                recommenderId
            );
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        const wallet = new WalletProvider(
            this.connection,
            new PublicKey(Wallet!)
        );
        const prices = await wallet.fetchPrices(runtime);
        const solPrice = prices.solana.usd;
        const sellSol = sellDetails.sell_amount / parseFloat(solPrice);
        const sell_value_usd =
            sellDetails.sell_amount * processedData.tradeData.price;
        const trade = await this.trustScoreDb.getLatestTradePerformance(
            tokenAddress,
            recommender.id,
            isSimulation
        );
        const buyTimeStamp = trade.buy_timeStamp;
        const marketCap =
            processedData.dexScreenerData.pairs[0]?.marketCap || 0;
        const liquidity =
            processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0;
        const sell_price = processedData.tradeData.price;
        const profit_usd = sell_value_usd - trade.buy_value_usd;
        const profit_percent = (profit_usd / trade.buy_value_usd) * 100;

        const market_cap_change = marketCap - trade.buy_market_cap;
        const liquidity_change = liquidity - trade.buy_liquidity;

        const isRapidDump = await this.isRapidDump(tokenAddress);

        const sellDetailsData = {
            sell_price: sell_price,
            sell_timeStamp: sellTimeStamp,
            sell_amount: sellDetails.sell_amount,
            received_sol: sellSol,
            sell_value_usd: sell_value_usd,
            profit_usd: profit_usd,
            profit_percent: profit_percent,
            sell_market_cap: marketCap,
            market_cap_change: market_cap_change,
            sell_liquidity: liquidity,
            liquidity_change: liquidity_change,
            rapidDump: isRapidDump,
            sell_recommender_id: sellDetails.sell_recommender_id || null,
        };
        this.trustScoreDb.updateTradePerformanceOnSell(
            tokenAddress,
            recommender.id,
            buyTimeStamp,
            sellDetailsData,
            isSimulation
        );
        if (isSimulation) {
            // If the trade is a simulation update the balance
            const oldBalance = this.trustScoreDb.getTokenBalance(tokenAddress);
            const tokenBalance = oldBalance - sellDetails.sell_amount;
            this.trustScoreDb.updateTokenBalance(tokenAddress, tokenBalance);
            // generate some random hash for simulations
            const hash = Math.random().toString(36).substring(7);
            const transaction = {
                tokenAddress: tokenAddress,
                type: "sell" as "buy" | "sell",
                transactionHash: hash,
                amount: sellDetails.sell_amount,
                price: processedData.tradeData.price,
                isSimulation: true,
                timestamp: new Date().toISOString(),
            };
            this.trustScoreDb.addTransaction(transaction);
        }

        return sellDetailsData;
    }

    // get all recommendations
    async getRecommendations(
        startDate: Date,
        endDate: Date
    ): Promise<Array<TokenRecommendationSummary>> {
        const recommendations = await this.trustScoreDb.getRecommendationsByDateRange(
            startDate,
            endDate
        );

        // Group recommendations by tokenAddress
        const groupedRecommendations = recommendations.reduce(
            (acc, recommendation) => {
                const { tokenAddress } = recommendation;
                if (!acc[tokenAddress]) acc[tokenAddress] = [];
                acc[tokenAddress].push(recommendation);
                return acc;
            },
            {} as Record<string, Array<ITokenRecommendation>> // Updated type
        );

        interface RecommenderData {
            recommenderId: string;
            trustScore: number;
            riskScore: number;
            consistencyScore: number;
            recommenderMetrics: IRecommenderMetrics;
        }

        const processedResults = await Promise.all(Object.keys(groupedRecommendations).map(
            async (tokenAddress) => {
                const tokenRecommendations =
                    groupedRecommendations[tokenAddress];

                // Initialize variables to compute averages
                let totalTrustScore = 0;
                let totalRiskScore = 0;
                let totalConsistencyScore = 0;
                const recommenderData: RecommenderData[] = [];

                const recommendationResults = await Promise.all(tokenRecommendations.map(async (recommendation) => {
                    const [tokenPerformance, recommenderMetrics] = await Promise.all([
                        this.trustScoreDb.getTokenPerformance(
                            recommendation.tokenAddress
                        ),
                        this.trustScoreDb.getRecommenderMetrics(
                            recommendation.recommenderId
                        )
                    ]);

                    const trustScore = this.calculateTrustScore(
                        tokenPerformance,
                        recommenderMetrics
                    );
                    const consistencyScore = this.calculateConsistencyScore(
                        tokenPerformance,
                        recommenderMetrics
                    );
                    const riskScore = this.calculateRiskScore(tokenPerformance);

                    return {
                        recommenderId: recommendation.recommenderId,
                        trustScore,
                        riskScore,
                        consistencyScore,
                        recommenderMetrics,
                    };
                }));

                // Process results and accumulate scores
                recommendationResults.forEach(result => {
                    totalTrustScore += result.trustScore;
                    totalRiskScore += result.riskScore;
                    totalConsistencyScore += result.consistencyScore;
                    recommenderData.push(result);
                });

                // Calculate averages for this token
                const averageTrustScore =
                    totalTrustScore / tokenRecommendations.length;
                const averageRiskScore =
                    totalRiskScore / tokenRecommendations.length;
                const averageConsistencyScore =
                    totalConsistencyScore / tokenRecommendations.length;

                return {
                    tokenAddress,
                    averageTrustScore,
                    averageRiskScore,
                    averageConsistencyScore,
                    recommenders: recommenderData,
                };
            }
        ));

        // Sort recommendations by the highest average trust score
        return processedResults.sort((a: TokenRecommendationSummary, b: TokenRecommendationSummary) => 
            b.averageTrustScore - a.averageTrustScore
        );
    }
}

export const trustScoreProvider: Provider = {
    async get(
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ): Promise<string> {
        try {
            const trustScoreDb = new TrustScoreDatabase(
                runtime.databaseAdapter.db
            );

            // Get the user ID from the message
            const userId = message.userId;

            if (!userId) {
                console.error("User ID is missing from the message");
                return "";
            }

            // Get the recommender metrics for the user
            const recommenderMetrics =
                await trustScoreDb.getRecommenderMetrics(userId);

            if (!recommenderMetrics) {
                console.error("No recommender metrics found for user:", userId);
                return "";
            }

            // Compute the trust score
            const trustScore = recommenderMetrics.trustScore;

            const user = await runtime.databaseAdapter.getAccountById(userId);

            // Format the trust score string
            if (!user) {
                throw new Error('User not found');
            }
            const trustScoreString = `${user.name}'s trust score: ${trustScore.toFixed(2)}`;

            return trustScoreString;
        } catch (error) {
            console.error("Error in trust score provider:", (error as Error).message); // Corrected error handling
            return `Failed to fetch trust score: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
    },
};