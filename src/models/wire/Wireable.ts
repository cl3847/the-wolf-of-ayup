import {CommandInteraction, InteractionResponse, MessageComponentInteraction} from "discord.js";
import WireTransaction from "../transaction/WireTransaction";
import {confirmedEmbed, diffBlock, dollarize} from "../../utils/helpers";
import config from "../../../config";
import User from "../user/User";

abstract class Wireable {
    name: string;
    identifier: string;

    protected constructor(name: string, identifier: string) {
        this.name = name;
        this.identifier = identifier;
    }

    async onWire(interaction: CommandInteraction, fromUser: User, amount: number): Promise<void> {
        const response = await this.previewWire(interaction, fromUser, amount);
        const confirmation = await response.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 60_000 });
        if (confirmation.customId === 'confirm') {
            const transaction = await this.executeWire(fromUser, amount);
            await this.onSuccess(confirmation, transaction);
        } else if (confirmation.customId === 'cancel') {
            await confirmation.update(
                {
                    embeds: [
                        ...(await response.fetch()).embeds,
                        confirmedEmbed(diffBlock(`- WIRE CANCELLED -\nOrder to wire **${this.name}** a total of $${dollarize(amount)} cancelled.`), config.colors.blue)
                    ],
                    components: []
            });
        }
    }

    protected abstract previewWire(interaction: CommandInteraction, fromUid: User, amount: number): Promise<InteractionResponse<boolean>>;
    protected abstract executeWire(fromUser: User, amount: number): Promise<WireTransaction>;
    protected abstract onSuccess(confirmation: MessageComponentInteraction, transaction: WireTransaction): Promise<void>;
}

export default Wireable;