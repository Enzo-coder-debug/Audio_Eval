CREATE TABLE `evaluationDimensions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`questionnaireId` int NOT NULL,
	`dimensionName` varchar(255) NOT NULL,
	`description` text,
	`weight` decimal(5,2) DEFAULT '1',
	`maxScore` decimal(5,2) DEFAULT '10',
	`orderIndex` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `evaluationDimensions_id` PRIMARY KEY(`id`)
);
