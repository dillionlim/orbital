# SQL script name in the root directory
SQL_SCRIPT="down.sql"

# Directory where the migrations are stored
MIGRATIONS_DIR="./prisma/migrations"

# Check if the SQL script exists
if [ ! -f "./$SQL_SCRIPT" ]; then
    echo "$SQL_SCRIPT does not exist in the current directory."
    exit 1  # Exit the script with an error code
fi

# Find the most recently created directory in the migrations directory
NEWEST_DIR=$(ls -td -- "$MIGRATIONS_DIR"/*/ | head -n 1)

# Check if the migrations directory is not empty and a directory was found
if [ -z "$NEWEST_DIR" ]; then
    echo "No migration directory found in $MIGRATIONS_DIR."
    exit 1  # Exit the script with an error code
fi

# Copy the SQL script to the newly created migration directory
cp "./$SQL_SCRIPT" "$NEWEST_DIR"

# Check if the copy was successful
if [ $? -eq 0 ]; then
    echo "Copied $SQL_SCRIPT to $NEWEST_DIR"
    # Delete the SQL script after copying
    rm "./$SQL_SCRIPT"
    echo "$SQL_SCRIPT has been deleted after copying."
else
    echo "Failed to copy $SQL_SCRIPT."
    exit 1  # Exit the script with an error code
fi