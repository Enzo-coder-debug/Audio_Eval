ALTER TABLE `questionnaires` MODIFY COLUMN `audioFileId` int;--> statement-breakpoint
ALTER TABLE `questionnaires` MODIFY COLUMN `evaluationCopywriting` longtext;--> statement-breakpoint
ALTER TABLE `questionnaires` MODIFY COLUMN `scoringStandard` longtext;--> statement-breakpoint
ALTER TABLE `responses` MODIFY COLUMN `userId` int;--> statement-breakpoint
ALTER TABLE `questionnaires` ADD `audioUrl` varchar(1024);--> statement-breakpoint
ALTER TABLE `questionnaires` ADD `shareToken` varchar(64);--> statement-breakpoint
ALTER TABLE `responses` ADD `visitorIp` varchar(45);--> statement-breakpoint
ALTER TABLE `responses` ADD `visitorName` varchar(255);--> statement-breakpoint
ALTER TABLE `questionnaires` ADD CONSTRAINT `questionnaires_shareToken_unique` UNIQUE(`shareToken`);