<?php
/**
 * Bridge de Emergencia V7 - MÁXIMA COMPATIBILIDAD
 * Ubicación recomendada: /assets/perfex_bridge.php
 */
header('Content-Type: application/json; charset=utf-8');
define('BASEPATH', 'index.php');

// Buscamos la carpeta config subiendo un nivel desde assets
$possible_path = dirname(__DIR__) . '/application/config/app-config.php';

if (!file_exists($possible_path)) {
    // Si no está ahí, probamos en la raíz por si acaso
    $possible_path = __DIR__ . '/application/config/app-config.php';
}

if (!file_exists($possible_path)) {
    die(json_encode(['error' => 'No se encontró app-config.php en ' . $possible_path]));
}

require_once($possible_path);

$secret_key = "EgyysBsXsJsKNj5HGWfF";
$received_token = $_GET['token'] ?? $_POST['token'] ?? '';

if (trim($received_token) !== trim($secret_key)) {
    http_response_code(401);
    die(json_encode(['error' => 'Token inválido', 'received' => $received_token]));
}

$conn = mysqli_connect(APP_DB_HOSTNAME, APP_DB_USERNAME, APP_DB_PASSWORD, APP_DB_NAME);
mysqli_set_charset($conn, "utf8");

$json_input = file_get_contents('php://input');
$data_json = json_decode($json_input, true);
$action = $_GET['action'] ?? $_POST['action'] ?? ($data_json['action'] ?? '');
$response = [];

switch ($action) {
    case 'get_customer_by_phone':
        $phone = preg_replace('/\D/', '', $_GET['phone'] ?? '');
        $last7 = substr($phone, -7);
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company, c.email, cl.vat 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.phonenumber LIKE '%$last7%' OR cl.phonenumber LIKE '%$last7%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        $response = ($r = mysqli_fetch_assoc($res)) ? array_merge($r, ['found' => true]) : ['found' => false];
        break;

    case 'get_customer_by_email':
        $email = mysqli_real_escape_string($conn, trim($_GET['email'] ?? ''));
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company, c.email, cl.vat 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.email = '$email' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        $response = ($r = mysqli_fetch_assoc($res)) ? array_merge($r, ['found' => true]) : ['found' => false];
        break;

    case 'get_customer_by_vat':
        $vat = mysqli_real_escape_string($conn, trim($_GET['vat'] ?? ''));
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company, c.email, cl.vat 
                FROM tblclients cl 
                LEFT JOIN tblcontacts c ON cl.userid = c.userid AND c.is_primary = 1 
                WHERE cl.vat LIKE '%$vat%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        $response = ($r = mysqli_fetch_assoc($res)) ? array_merge($r, ['found' => true]) : ['found' => false];
        break;

    case 'get_invoices':
        $cid = intval($_GET['customer_id']);
        $sql = "SELECT id, number, total, status, hash FROM tblinvoices WHERE clientid = $cid AND status != 2 ORDER BY date DESC LIMIT 5";
        $res = mysqli_query($conn, $sql);
        while ($row = mysqli_fetch_assoc($res)) {
            $row['view_url'] = "https://portal.gmgroup.com.co/invoice/" . $row['id'] . "/" . $row['hash'];
            $response[] = $row;
        }
        break;

    case 'get_projects':
        $cid = intval($_GET['customer_id']);
        $sql = "SELECT name as travel_plan FROM tblprojects WHERE clientid = $cid LIMIT 3";
        $res = mysqli_query($conn, $sql);
        while ($row = mysqli_fetch_assoc($res)) $response[] = $row;
        break;

    case 'create_ticket':
        $data = is_array($data_json) ? $data_json : $_POST;
        $subject = mysqli_real_escape_string($conn, $data['subject'] ?? 'Consulta desde WhatsApp');
        $message = mysqli_real_escape_string($conn, $data['message'] ?? '');
        $priority = intval($data['priority'] ?? 2);
        $department = intval($data['department'] ?? 1);
        $userid = intval($data['customerId'] ?? 0);
        
        $sql = "INSERT INTO tbltickets (subject, message, priority, department, userid, date, status) 
                VALUES ('$subject', '$message', $priority, $department, $userid, '" . date('Y-m-d H:i:s') . "', 1)";
        
        if (mysqli_query($conn, $sql)) {
            $response = ['status' => 'success', 'ticket_id' => mysqli_insert_id($conn)];
        } else {
            $response = ['status' => 'error', 'message' => mysqli_error($conn)];
        }
        break;

    case 'create_lead':
        $data = is_array($data_json) ? $data_json : $_POST;
        $name = mysqli_real_escape_string($conn, $data['name'] ?? 'Cliente WhatsApp');
        $email = mysqli_real_escape_string($conn, $data['email'] ?? '');
        $phonenumber = mysqli_real_escape_string($conn, $data['phonenumber'] ?? '');
        $description = mysqli_real_escape_string($conn, $data['description'] ?? 'Interés desde WhatsApp AI');
        
        $sql = "INSERT INTO tblleads (name, email, phonenumber, description, source, status, dateadded) 
                VALUES ('$name', '$email', '$phonenumber', '$description', 1, 1, '" . date('Y-m-d H:i:s') . "')";
        
        if (mysqli_query($conn, $sql)) {
            $response = ['status' => 'success', 'lead_id' => mysqli_insert_id($conn)];
        } else {
            $response = ['status' => 'error', 'message' => mysqli_error($conn)];
        }
        break;

    case 'send_piping_email':
        $data = is_array($data_json) ? $data_json : $_POST;
        $to = mysqli_real_escape_string($conn, $data['to'] ?? '');
        $from = mysqli_real_escape_string($conn, $data['from_email'] ?? '');
        $subject = $data['subject'] ?? 'Nuevo Ticket WhatsApp';
        $body = $data['body'] ?? '';

        // Headers para que Perfex reconozca al remitente original
        $headers = "From: $from\r\n";
        $headers .= "Reply-To: $from\r\n";
        $headers .= "X-Mailer: PHP/" . phpversion() . "\r\n";
        $headers .= "Content-Type: text/plain; charset=utf-8\r\n";

        if (mail($to, $subject, $body, $headers)) {
            $response = ['status' => 'success', 'message' => 'Email enviado al piping'];
        } else {
            $response = ['status' => 'error', 'message' => 'Fallo al enviar correo'];
        }
        break;

    case 'send_piping_email':
        $data = is_array($data_json) ? $data_json : $_POST;
        $to = mysqli_real_escape_string($conn, $data['to'] ?? '');
        $from = mysqli_real_escape_string($conn, $data['from_email'] ?? '');
        $subject = $data['subject'] ?? 'Nuevo Ticket WhatsApp';
        $body = $data['body'] ?? '';

        // Headers para simular que el correo viene del cliente
        $headers = "From: $from\r\n";
        $headers .= "Reply-To: $from\r\n";
        $headers .= "X-Mailer: PHP/" . phpversion() . "\r\n";
        $headers .= "Content-Type: text/plain; charset=utf-8\r\n";

        if (mail($to, $subject, $body, $headers)) {
            $response = ['status' => 'success', 'message' => 'Email enviado al piping'];
        } else {
            $response = ['status' => 'error', 'message' => 'Fallo al enviar correo'];
        }
        break;
}

echo json_encode($response, JSON_UNESCAPED_UNICODE);
mysqli_close($conn);