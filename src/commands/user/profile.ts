import {
    AttachmentBuilder,
    CacheType,
    ChatInputCommandInteraction,
    EmbedBuilder,
    SlashCommandBuilder,
    User
} from "discord.js";
import Service from "../../services/Service";
import CommandType from "../../types/CommandType";
import UserPortfolio from "src/models/user/UserPortfolio";
import config from "../../../config";
import {confirmedEmbed, diffBlock, dollarize, EMBED_PADDING, handleEmbedNavigator} from "../../utils/helpers";
import Price from "../../models/Price";
import {createLinePortfolioImage} from "../../utils/graphing";
import log from "../../utils/logger";

//

const command: CommandType = {
    data: new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Displays your profile and portfolio information.')
        .addUserOption(
            option =>
                option.setName('user')
                    .setDescription('The user to lookup')
                    .setRequired(false)
        ),
    async execute(interaction: ChatInputCommandInteraction<CacheType>) {
        const service = Service.getInstance();
        const user = interaction.options.getUser('user') || interaction.user;
        const userPortfolio = await service.users.getUserPortfolio(user.id);
        if (!userPortfolio) {
            await interaction.reply({embeds: [confirmedEmbed(diffBlock(`- LOOKUP FAILED -\nUser ${user.username}'s profile does not exist.`), config.colors.blue)]});
            return;
        }
        const yesterdayPrices = await service.stocks.getAllYesterdayPrice();

        let embed = await generateProfileEmbed(userPortfolio, yesterdayPrices, user);
        let inventoryEmbed = generateInventoryEmbed(userPortfolio, user);

        const files: AttachmentBuilder[] = [];
        try {
            const image: Buffer = await createLinePortfolioImage(user.id);
            const chartAttachment = new AttachmentBuilder(image, {name: 'line.png'});
            files.push(chartAttachment);
            embed.setImage('attachment://line.png');
        } catch (e) {
            log.error('Error creating line image for user ' + user.id);
        }

        const fileMap = new Map<number, AttachmentBuilder[]>();
        fileMap.set(0, files);

        await handleEmbedNavigator(interaction, [embed, inventoryEmbed], fileMap, 300_000);
    },
};

const generateProfileEmbed = async (userPortfolio: UserPortfolio, yesterdayPrices: Price[], user: User) => {
    let totalPriceDiff = 0;
    let totalYesterdayPrice = 0;
    let displayPortfolio = userPortfolio.portfolio.map(hs => {
        const yesterdayPrice = yesterdayPrices.find(p => p.ticker === hs.ticker);
        const priceDiff = (hs.price * hs.quantity - (yesterdayPrice ? yesterdayPrice.close_price * hs.quantity : 0));
        const priceDiffPercent = priceDiff / (yesterdayPrice ? yesterdayPrice.close_price * hs.quantity : 1);
        const percentDisplay = yesterdayPrice !== undefined ? (priceDiffPercent * 100).toFixed(2) : "N/A";

        totalPriceDiff += priceDiff;
        totalYesterdayPrice += (yesterdayPrice ? yesterdayPrice.close_price * hs.quantity : 0);

        return `${hs.ticker} - ${hs.quantity} share(s) - $${dollarize(hs.price * hs.quantity)}\n${priceDiff >= 0 ? '+' : '-'}$${dollarize(Math.abs(priceDiff))} (${percentDisplay}%)`;
    }).join('\n') || 'No stocks owned.';

    const {diff: valueDiff, percent: valueDiffPercent} = await userPortfolio.getDayPortfolioChange();
    const percentDisplay = valueDiffPercent !== null ? (valueDiffPercent * 100).toFixed(2) : "N/A";

    if (userPortfolio.portfolio.length > 0) {
        displayPortfolio += `\n${EMBED_PADDING}$${dollarize(userPortfolio.portfolioValue())} total portfolio value\n${valueDiff >= 0 ? '+' : '-'}$${dollarize(Math.abs(valueDiff))} (${percentDisplay}%) change today`;
    }

    return new EmbedBuilder()
        .setColor(config.colors.green)
        .setAuthor({name: `${user.displayName}'s Profile`, iconURL: user.avatarURL() || undefined})
        .addFields(
            {
                name: 'Financials', value: diffBlock(`  $${dollarize(userPortfolio.balance)} account balance\n` +
                    `+ $${dollarize(userPortfolio.portfolioValue())} total portfolio value\n` +
                    (userPortfolio.loan_balance > 0 ? `- $${dollarize(userPortfolio.loan_balance)} debt to ${config.theme.financialCompanyName}\n` : "") +
                    `= $${dollarize(userPortfolio.netWorth())} NET WORTH\n\n` +
                    `Credit Limit: $${dollarize(userPortfolio.credit_limit)}\n` +
                    `${(Math.floor(userPortfolio.loan_balance / userPortfolio.credit_limit * 10000) / 100).toFixed(2)}% utilization`,
                )
            },
            {name: 'Portfolio', value: diffBlock(displayPortfolio)},
        )
        .setTimestamp(new Date());
};


function generateInventoryEmbed(userPortfolio: UserPortfolio, user: User) {
    return new EmbedBuilder()
        .setColor(config.colors.green)
        .setAuthor({name: `${user.displayName}'s Inventory`, iconURL: user.avatarURL() || undefined})
        .setDescription(diffBlock("ID - ITEM - QUANTITY\n" +
            userPortfolio.inventory.map(hi => {
                return `${hi.item_id} - ${hi.name} - x${hi.quantity}`
            }).join('\n')))
        .setTimestamp(new Date());
}

module.exports = command;