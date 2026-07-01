CREATE TABLE `blindTestPairs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`questionnaireId` int NOT NULL,
	`leftAudioFileId` int NOT NULL,
	`rightAudioFileId` int NOT NULL,
	`pairIndex` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `blindTestPairs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `answers` MODIFY COLUMN `questionId` int;--> statement-breakpoint
ALTER TABLE `answers` MODIFY COLUMN `answerContent` longtext;--> statement-breakpoint
ALTER TABLE `responses` MODIFY COLUMN `questionnaireId` int;--> statement-breakpoint
ALTER TABLE `answers` ADD `evaluationDimensionId` int;--> statement-breakpoint
ALTER TABLE `answers` ADD `blindTestChoice` enum('left_better','same','right_better');--> statement-breakpoint
ALTER TABLE `audioFiles` ADD `modelName` varchar(255);--> statement-breakpoint
ALTER TABLE `audioFiles` ADD `asrText` longtext;--> statement-breakpoint
ALTER TABLE `responses` ADD `blindTestPairId` int;